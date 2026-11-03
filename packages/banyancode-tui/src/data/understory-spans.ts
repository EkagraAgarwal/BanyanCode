import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { toolArgs, totalTokens } from "./messages"
import {
  canonicalTool,
  diffCounts,
  toolKind,
  toolPath,
  type RosterRow,
  type ToolLetter,
  type UnderstoryState,
} from "./understory"

/**
 * Pure span data for the Trace lens: one ordered list of what an agent did, in
 * wall-clock time, from the parts the host already stores. Nothing here reads
 * the clock and nothing imports Solid: the caller passes the playhead `T`, so
 * replay is the same call with an older `T`.
 */

export type SpanKind = "tool" | "think" | "write" | "ask" | "retry" | "wait"

export interface AgentSpan {
  readonly id: string
  readonly kind: SpanKind
  readonly t0: number
  /** Absent while the span is still open. */
  readonly t1?: number
  readonly letter: ToolLetter
  readonly name: string
  readonly target: string
  readonly file?: string
  readonly error?: string
  readonly added?: number
  readonly removed?: number
  /** A finished tool's own text output, for the Call sheet. Absent when it returned none. */
  readonly output?: string
  /** The assistant message the span came from, for token attribution. */
  readonly messageID?: string
}

/** Newest spans kept per session; the host's message cap bounds this further. */
export const SPAN_CAP_PER_SESSION = 400

export interface SpanOptions {
  /** The row's state, so a trailing ask/retry/wait span can be drawn. */
  readonly state?: UnderstoryState | undefined
  /** The pending request's summary, shown as the ask span's target. */
  readonly ask?: string | undefined
  /** The row's start, so a trailing span never begins before the run did. */
  readonly start?: number | undefined
  /** Newest spans kept; defaults to `SPAN_CAP_PER_SESSION`. */
  readonly limit?: number | undefined
}

const clip = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

const open = (part: SessionMessageAssistantTool): boolean =>
  part.state.status === "streaming" || part.state.status === "running"

/** A finished tool's text content, joined into the output the Call sheet shows. */
function toolOutput(part: SessionMessageAssistantTool): string | undefined {
  if (part.state.status === "streaming" || part.state.status === "running") return undefined
  const text = (part.state.content ?? [])
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .trim()
  return text === "" ? undefined : text
}

function toolSpan(part: SessionMessageAssistantTool, messageID: string, sequence: number): AgentSpan {
  const canonical = canonicalTool(part.name)
  const start = part.time.ran ?? part.time.created
  const finished = open(part) ? undefined : (part.time.completed ?? start)
  const counts = diffCounts(part.state)
  const path = toolPath(part.state.input)
  const error = part.state.status === "error" ? clip(part.state.error.message, 80) : undefined
  const output = toolOutput(part)
  return {
    id: `${messageID}:${sequence}`,
    kind: "tool",
    t0: start,
    ...(finished === undefined ? {} : { t1: finished }),
    letter: toolKind(part.name),
    name: canonical,
    target: toolArgs(part.state.input, 48),
    ...(path === undefined ? {} : { file: path }),
    ...(error === undefined ? {} : { error }),
    ...(counts === undefined ? {} : { added: counts.added, removed: counts.removed }),
    ...(output === undefined ? {} : { output }),
    messageID,
  }
}

function messageSpans(message: Extract<SessionMessageInfo, { type: "assistant" }>): AgentSpan[] {
  const spans: AgentSpan[] = []
  const created = message.time.created
  const completed = message.time.completed
  if (message.retry !== undefined) {
    spans.push({
      id: `${message.id}:retry`,
      kind: "retry",
      t0: message.retry.at,
      ...(completed === undefined || completed <= message.retry.at ? {} : { t1: completed }),
      letter: "?",
      name: "retry",
      target: `attempt ${message.retry.attempt}`,
      error: clip(message.retry.error.message, 80),
      messageID: message.id,
    })
  }
  message.content.forEach((part, index) => {
    if (part.type === "tool") {
      spans.push(toolSpan(part, message.id, index))
      return
    }
    if (part.type === "reasoning") {
      const start = part.time?.created ?? created
      const end = part.time?.completed ?? completed
      if (part.text.trim() === "") return
      spans.push({
        id: `${message.id}:${index}`,
        kind: "think",
        t0: start,
        ...(end === undefined ? {} : { t1: end }),
        letter: "?",
        name: "thinking",
        target: clip(part.text, 48),
        messageID: message.id,
      })
      return
    }
    if (part.text.trim() === "") return
    const start = message.time.streamed ?? created
    spans.push({
      id: `${message.id}:${index}`,
      kind: "write",
      t0: start,
      ...(completed === undefined ? {} : { t1: completed }),
      letter: "?",
      name: "writing",
      target: clip(part.text, 60),
      messageID: message.id,
    })
  })
  return spans
}

/**
 * Every span a session's loaded messages describe, oldest first. Pending-ask,
 * retry and blocked spans come from the row's state, because the messages
 * themselves do not record the wait.
 */
export function agentSpans(
  messages: readonly SessionMessageInfo[],
  options: SpanOptions = {},
): AgentSpan[] {
  const spans = messages
    .flatMap((message) => (message.type === "assistant" ? messageSpans(message) : []))
    .sort((left, right) => left.t0 - right.t0 || left.id.localeCompare(right.id))
  const tail =
    spans.length === 0
      ? 0
      : spans.reduce((last, span) => Math.max(last, span.t1 ?? span.t0), 0)
  const started = Math.max(tail, options.start ?? 0)
  const appended =
    options.state === undefined
      ? []
      : options.state === "waiting"
        ? [
            {
              id: "ask",
              kind: "ask" as const,
              t0: started,
              letter: "?" as const,
              name: "ask",
              target: options.ask ?? "",
            },
          ]
        : options.state === "retry"
          ? [{ id: "retry", kind: "retry" as const, t0: started, letter: "?" as const, name: "retry", target: "" }]
          : options.state === "blocked"
            ? [{ id: "wait", kind: "wait" as const, t0: started, letter: "?" as const, name: "waiting", target: "" }]
            : []
  const limit = Math.max(1, Math.floor(options.limit ?? SPAN_CAP_PER_SESSION))
  return [...spans, ...appended].slice(-limit)
}

/** The span covering `t`, or the last one that ended before it. */
export function spanAt(spans: readonly AgentSpan[], t: number): AgentSpan | undefined {
  let low = 0
  let high = spans.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (spans[middle]!.t0 <= t) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (found < 0) return undefined
  const span = spans[found]!
  return span.t1 === undefined || span.t1 > t ? span : undefined
}

/**
 * The row's state at `T`. Ended rows keep their terminal state, so a failed or
 * killed agent never rewinds to running.
 */
export function stateAt(row: RosterRow, spans: readonly AgentSpan[], t: number): UnderstoryState {
  if (t < row.startedAt) return "idle"
  if (row.endedAt !== undefined && t >= row.endedAt) return row.state
  const span = spanAt(spans, t)
  if (span?.kind === "ask") return "waiting"
  if (span?.kind === "retry") return "retry"
  if (span?.kind === "wait") return "blocked"
  return "running"
}

/**
 * A replay reads the same history with an earlier `T`: nothing after T exists.
 * These helpers are the one place that rule lives, so the lenses, the roster
 * and the inspector cannot disagree about what happened by a given time.
 */

/** Messages that had arrived by `t`. */
export function messagesAt(messages: readonly SessionMessageInfo[], t: number): SessionMessageInfo[] {
  return messages.filter((message) => message.time.created <= t)
}

/**
 * The tokens an agent had produced by `t`: a message's usage counts once it
 * completed, so a half-streamed reply never inflates the total.
 */
export function tokensAt(messages: readonly SessionMessageInfo[], t: number): number {
  return messages.reduce((total, message) => {
    if (message.type !== "assistant") return total
    if (message.time.completed === undefined || message.time.completed > t) return total
    return total + totalTokens(message.tokens)
  }, 0)
}

/** Spans that had started by `t`, with any still open at `t` closed there. */
export function spansAt(spans: readonly AgentSpan[], t: number): AgentSpan[] {
  return spans
    .filter((span) => span.t0 <= t)
    .map((span) => (span.t1 !== undefined && span.t1 > t ? { ...span, t1: t } : span))
}

/**
 * Whether the messages carry per-message usage at all. Without it a replay has
 * no signal to sum, so the row keeps the session's own total instead of zero.
 */
function hasUsage(messages: readonly SessionMessageInfo[]): boolean {
  return messages.some((message) => message.type === "assistant" && message.tokens !== undefined)
}

/**
 * The row as it stood at `t`: its state, its tokens and whether it had ended.
 * A row that ends after the playhead is still running, and a tool count never
 * includes a call that had not started.
 */
export function rowAt(
  row: RosterRow,
  spans: readonly AgentSpan[],
  messages: readonly SessionMessageInfo[],
  t: number,
): RosterRow {
  const ended = row.endedAt !== undefined && row.endedAt <= t ? row.endedAt : undefined
  const state = stateAt(row, spans, t)
  return {
    ...row,
    state,
    tokens: hasUsage(messages) ? tokensAt(messages, t) : row.tokens,
    endedAt: ended,
    pending: state === "waiting" ? row.pending : 0,
  }
}

/** Tool calls an agent had started by `t`, which the now column reports. */
export function toolCountAt(spans: readonly AgentSpan[], t: number): number {
  return spans.filter((span) => span.kind === "tool" && span.t0 <= t).length
}

/** `1.2s`, for the duration of an open call and the now column. */
export function durationText(ms: number): string {
  if (ms < 0) return "0.0s"
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * One line per lane: what this agent is doing at `T`, in the shape the now
 * column uses ("edit postinstall.mjs 1.2s", "writing", "needs you: npm pack").
 * A finished row shows the text of its last reply, which is its return.
 */
export function nowText(row: RosterRow, spans: readonly AgentSpan[], t: number): string {
  if (t < row.startedAt) return ""
  if (row.endedAt !== undefined && t >= row.endedAt) {
    if (row.state !== "done") return row.state === "killed" ? "killed" : row.state === "failed" ? "failed" : ""
    const returned = spans.findLast((span) => span.kind === "write")
    return returned === undefined ? "" : returned.target
  }
  const span = spanAt(spans, t)
  if (span === undefined) return ""
  if (span.kind === "ask") return span.target === "" ? "needs you" : `needs you: ${span.target}`
  if (span.kind === "wait") return "waiting on branches"
  if (span.kind === "retry") return "retrying"
  if (span.kind === "think") return "thinking"
  if (span.kind === "write") return "writing"
  const elapsed = span.t1 === undefined ? t - span.t0 : span.t1 - span.t0
  const head = span.target === "" ? span.name : `${span.name} ${span.target}`
  return `${head} ${durationText(elapsed)}`
}

export interface TokenBucket {
  readonly t0: number
  readonly t1: number
  /** Tokens that streamed inside the bucket. */
  readonly tokens: number
  /** Tokens per second across the bucket; zero when nothing streamed. */
  readonly rate: number
}
const generated = (message: Extract<SessionMessageInfo, { type: "assistant" }>): number => {
  if (message.tokens === undefined) return 0
  return message.tokens.output + message.tokens.reasoning
}

/**
 * Token rate per column between `from` and `to`. A message's real tokens are
 * spread evenly over the interval it streamed, so the bars carry signal and
 * never a synthesised wobble; a bucket with no signal reads zero and the lane
 * draws a flat bar for the turn instead.
 */
export function tokenBuckets(
  spans: readonly AgentSpan[],
  messages: readonly SessionMessageInfo[],
  from: number,
  to: number,
  columns: number,
): TokenBucket[] {
  const count = Math.max(0, Math.floor(columns))
  if (count === 0) return []
  const step = (to - from) / count
  if (!(step > 0)) return []
  const tokens = new Array<number>(count).fill(0)
  for (const message of messages) {
    if (message.type !== "assistant") continue
    const total = generated(message)
    if (total === 0) continue
    const own = spans.filter((span) => span.messageID === message.id)
    const observed = own.reduce((last, span) => Math.max(last, span.t1 ?? span.t0), message.time.created)
    const start = message.time.created
    const end = message.time.completed ?? (observed > start ? observed : to)
    const length = end - start
    if (!(length > 0)) continue
    for (let index = 0; index < count; index += 1) {
      const t0 = from + index * step
      const overlap = Math.min(end, t0 + step) - Math.max(start, t0)
      if (overlap <= 0) continue
      tokens[index] += (total * overlap) / length
    }
  }
  return tokens.map((value, index) => {
    const t0 = from + index * step
    return { t0, t1: t0 + step, tokens: value, rate: value / (step / 1000) }
  })
}

/** The sparkline's ceiling, in tokens per second: the mockup's own scale. */
export const SPARK_RATE_CEILING = 170
/** Rows a full-height sparkline cell carries. */
const SPARK_STEPS = 8

/**
 * The live token rate a session streamed in the last `windowMs`, from the
 * tokens its own assistant messages recorded. Zero when nothing streamed.
 */
export function tokenRate(
  messages: readonly SessionMessageInfo[],
  options: { readonly to: number; readonly windowMs?: number | undefined },
): number {
  const window = Math.max(1, options.windowMs ?? 10_000)
  const bucket = tokenBuckets([], messages, options.to - window, options.to, 1)[0]
  return bucket === undefined ? 0 : Math.max(0, bucket.rate)
}

/**
 * Sparkline heights for one session: one step per column, oldest first, from
 * the same token buckets the lanes use. Empty when the window holds no signal,
 * so a row never draws a decorative line.
 */
export function sparkValues(
  messages: readonly SessionMessageInfo[],
  options: { readonly to: number; readonly columns: number; readonly windowMs?: number | undefined },
): number[] {
  const columns = Math.max(0, Math.floor(options.columns))
  if (columns === 0) return []
  const span = Math.max(1, options.windowMs ?? 24_000)
  const buckets = tokenBuckets([], messages, options.to - span, options.to, columns)
  if (!buckets.some((bucket) => bucket.tokens > 0)) return []
  return buckets.map((bucket) => {
    const level = Math.round(Math.max(0, Math.min(1, bucket.rate / SPARK_RATE_CEILING)) * SPARK_STEPS)
    return Math.max(0, Math.min(SPARK_STEPS, level))
  })
}

// ---------------------------------------------------------------------------
// Stale edits
// ---------------------------------------------------------------------------

export interface SpanSession {
  readonly sessionID: string
  readonly label: string
  readonly messages: readonly SessionMessageInfo[]
}

export interface StaleEdit {
  readonly path: string
  /** The branch working from the stale read. */
  readonly reader: string
  readonly readerLabel: string
  /** The branch whose later edit the read predates. */
  readonly writer: string
  readonly writerLabel: string
  readonly readAt: number
  readonly editedAt: number
}

interface Touch {
  readonly sessionID: string
  readonly path: string
  readonly verb: "r" | "w"
  readonly at: number
}

const touches = (session: SpanSession): Touch[] =>
  session.messages.flatMap((message) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part): Touch[] => {
          if (part.type !== "tool") return []
          const letter = toolKind(part.name)
          if (letter !== "R" && letter !== "E") return []
          const path = toolPath(part.state.input)
          if (path === undefined) return []
          return [{ sessionID: session.sessionID, path, verb: letter === "E" ? "w" : "r", at: part.time.ran ?? part.time.created }]
        }),
  )

/**
 * The brief's advisory stale-read check: branch B edits a file that branch A
 * edited after B last read it, so B is working from a stale read. Computed from
 * sibling sessions' tool parts alone, and cleared when B re-reads the file.
 * A branch that never read the file is not reported: a blind edit is a
 * different problem, not a stale read. `to` is the replay playhead: a touch
 * after it has not happened yet.
 */
export function staleEdits(
  sessions: readonly SpanSession[],
  limit = 20,
  to = Number.POSITIVE_INFINITY,
): StaleEdit[] {
  const labels = new Map(sessions.map((session) => [session.sessionID, session.label]))
  const lastRead = new Map<string, number>()
  const lastWrite = new Map<string, { at: number; sessionID: string }>()
  const found = new Map<string, StaleEdit>()
  const key = (sessionID: string, path: string) => `${sessionID}\u0000${path}`
  const all = sessions
    .flatMap(touches)
    .filter((touch) => touch.at <= to)
    .sort((left, right) => left.at - right.at)
  for (const touch of all) {
    const slot = key(touch.sessionID, touch.path)
    if (touch.verb === "r") {
      lastRead.set(slot, touch.at)
      found.delete(slot)
      continue
    }
    const readAt = lastRead.get(slot)
    if (readAt === undefined) continue
    const previous = lastWrite.get(touch.path)
    lastWrite.set(touch.path, { at: touch.at, sessionID: touch.sessionID })
    if (previous === undefined || previous.sessionID === touch.sessionID || previous.at <= readAt) continue
    found.set(slot, {
      path: touch.path,
      reader: touch.sessionID,
      readerLabel: labels.get(touch.sessionID) ?? touch.sessionID,
      writer: previous.sessionID,
      writerLabel: labels.get(previous.sessionID) ?? previous.sessionID,
      readAt,
      editedAt: touch.at,
    })
  }
  return [...found.values()].sort((left, right) => left.editedAt - right.editedAt).slice(-limit)
}
