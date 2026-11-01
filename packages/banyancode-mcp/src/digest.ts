// Checkup digest: fold the durable session log into a small counter set and a
// short human-readable summary. This is the token-cheap core of
// `banyan_checkup` — the caller never receives raw events, transcript text, or
// patches here, only counts plus the tail of the last assistant message.
//
// Cursors are per-task durable `seq` values, packed into one opaque string:
//   b1.<base64url(JSON { t: { <taskID>: <seq> } })>
// A missing or malformed cursor means "from the beginning of each task's log".

export type DurableEvent = {
  type: string
  created?: number
  durable?: { aggregateID?: string; seq?: number; version?: number }
  data?: Record<string, unknown>
}

export type DigestTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type DigestState = {
  steps: number
  toolCalls: number
  toolFailures: number
  retries: number
  compactions: number
  executionsStarted: number
  executionsSucceeded: number
  executionsFailed: number
  executionsInterrupted: number
  lastText?: string
  lastTextAt?: number
  files: string[]
  toolNames: Record<string, number>
  /** Recent tool-call signatures, oldest first. Drives loop detection. */
  recentCalls: string[]
  cost: number
  tokens: DigestTokens
  lastSeq: number
  lastEventAt?: number
}

export const MAX_RECENT_CALLS = 12
export const MAX_FILES = 40

export const emptyDigest = (): DigestState => ({
  steps: 0,
  toolCalls: 0,
  toolFailures: 0,
  retries: 0,
  compactions: 0,
  executionsStarted: 0,
  executionsSucceeded: 0,
  executionsFailed: 0,
  executionsInterrupted: 0,
  files: [],
  toolNames: {},
  recentCalls: [],
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  lastSeq: 0,
})

// Key-order-independent JSON, so two identical tool inputs hash equally even
// when the model emits different key order.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
}

export function hashCall(name: string, input: unknown): string {
  const text = `${name}\u0000${stableStringify(safeJson(input))}`
  // FNV-1a, 32-bit: collision-tolerant for loop detection, cheap, no deps.
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, "0")}:${name}`
}

const safeJson = (value: unknown): unknown => {
  if (value === undefined) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value
  }
  try {
    // Structured-clone-ish guard: tool inputs come from JSON, but a fake port
    // in tests may hand over richer objects.
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "edit_file",
  "create_file",
  "notebook_edit",
])

const FILE_KEYS = ["filePath", "file_path", "path", "file", "filename", "target"] as const

const addUniqueBounded = (list: string[], value: string, bound: number): void => {
  if (list.includes(value)) return
  list.push(value)
  if (list.length > bound) list.splice(0, list.length - bound)
}

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const addTokens = (target: DigestTokens, value: unknown): void => {
  const tokens = asRecord(value)
  target.input += asNumber(tokens["input"])
  target.output += asNumber(tokens["output"])
  target.reasoning += asNumber(tokens["reasoning"])
  const cache = asRecord(tokens["cache"])
  target.cacheRead += asNumber(cache["read"])
  target.cacheWrite += asNumber(cache["write"])
}

export function foldDigest(state: DigestState, events: readonly DurableEvent[]): DigestState {
  const next: DigestState = {
    ...state,
    files: [...state.files],
    toolNames: { ...state.toolNames },
    recentCalls: [...state.recentCalls],
    tokens: { ...state.tokens },
  }
  for (const event of events) {
    const seq = asNumber(event.durable?.seq)
    if (seq > next.lastSeq) next.lastSeq = seq
    const created = asNumber(event.created)
    if (created > 0 && (next.lastEventAt === undefined || created > next.lastEventAt)) next.lastEventAt = created
    const data = asRecord(event.data)
    switch (event.type) {
      case "session.step.started":
        next.steps += 1
        break
      case "session.step.ended": {
        next.cost += asNumber(data["cost"])
        addTokens(next.tokens, data["tokens"])
        const files = data["files"]
        if (Array.isArray(files)) {
          for (const file of files) if (typeof file === "string") addUniqueBounded(next.files, file, MAX_FILES)
        }
        break
      }
      case "session.usage.recorded":
        next.cost += asNumber(data["cost"])
        addTokens(next.tokens, data["tokens"])
        break
      case "session.tool.called": {
        next.toolCalls += 1
        const name = typeof data["name"] === "string" ? data["name"] : "unknown"
        next.toolNames[name] = (next.toolNames[name] ?? 0) + 1
        const input = asRecord(data["input"])
        if (EDIT_TOOL_NAMES.has(name)) {
          for (const key of FILE_KEYS) {
            const file = input[key]
            if (typeof file === "string" && file !== "") {
              addUniqueBounded(next.files, file, MAX_FILES)
              break
            }
          }
        }
        next.recentCalls.push(hashCall(name, input))
        if (next.recentCalls.length > MAX_RECENT_CALLS) next.recentCalls.splice(0, next.recentCalls.length - MAX_RECENT_CALLS)
        break
      }
      case "session.tool.failed":
        next.toolFailures += 1
        break
      case "session.retry.scheduled":
        next.retries += 1
        break
      case "session.compaction.started":
      case "session.compaction.ended":
        next.compactions += 1
        break
      case "session.execution.started":
        next.executionsStarted += 1
        break
      case "session.execution.succeeded":
        next.executionsSucceeded += 1
        break
      case "session.execution.failed":
        next.executionsFailed += 1
        break
      case "session.execution.interrupted":
        next.executionsInterrupted += 1
        break
      case "session.text.ended": {
        const text = data["text"]
        if (typeof text === "string" && text.trim() !== "") {
          next.lastText = text
          next.lastTextAt = created > 0 ? created : next.lastTextAt
        }
        break
      }
      default:
        break
    }
  }
  return next
}

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`

export type DigestSummary = {
  steps: number
  tool_calls: number
  tool_failures: number
  retries: number
  compactions: number
  files: string[]
  files_count: number
  tools: Array<{ name: string; count: number }>
  last_text?: string
  cost: number
  tokens: { input: number; output: number }
  last_event_at?: number
}

export function summarizeDigest(
  state: DigestState,
  options: { maxTextChars?: number; maxFiles?: number; maxTools?: number } = {},
): DigestSummary {
  const maxTextChars = Math.max(40, options.maxTextChars ?? 240)
  const maxFiles = Math.max(0, options.maxFiles ?? 10)
  const maxTools = Math.max(1, options.maxTools ?? 6)
  const tools = Object.entries(state.toolNames)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxTools)
    .map(([name, count]) => ({ name, count }))
  const summary: DigestSummary = {
    steps: state.steps,
    tool_calls: state.toolCalls,
    tool_failures: state.toolFailures,
    retries: state.retries,
    compactions: state.compactions,
    files: state.files.slice(-maxFiles),
    files_count: state.files.length,
    tools,
    cost: Math.round(state.cost * 10_000) / 10_000,
    tokens: { input: state.tokens.input, output: state.tokens.output },
  }
  if (state.lastText !== undefined) summary.last_text = truncate(state.lastText.trim(), maxTextChars)
  if (state.lastEventAt !== undefined) summary.last_event_at = Math.floor(state.lastEventAt / 1000)
  return summary
}

// --- cursors ----------------------------------------------------------------

export type CursorState = Record<string, number>

const CURSOR_PREFIX = "b1."

export function encodeCursor(state: CursorState): string {
  // Positive = durable sequence, negative = transcript ordinal (see
  // transcript.ts); both are meaningful, only zero is "nothing yet".
  const compact: CursorState = {}
  for (const [task, seq] of Object.entries(state)) if (Number.isFinite(seq) && seq !== 0) compact[task] = seq
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({ t: compact }), "utf8").toString("base64url")}`
}

export function decodeCursor(cursor: string | undefined): CursorState {
  if (cursor === undefined || cursor === "") return {}
  if (!cursor.startsWith(CURSOR_PREFIX)) return {}
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as {
      t?: Record<string, unknown>
    }
    const out: CursorState = {}
    for (const [task, seq] of Object.entries(parsed.t ?? {})) {
      if (typeof seq === "number" && Number.isFinite(seq) && seq !== 0) out[task] = Math.trunc(seq)
    }
    return out
  } catch {
    return {}
  }
}

export * as Digest from "./digest"
