import type { Context } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"

/**
 * Agent-efficiency telemetry (`BANYANCODE_AGENT_TELEMETRY_KEY` parity).
 *
 * Port of v1 `packages/core/src/banyancode/agent-efficiency-telemetry.ts`
 * (key file, HMAC "local id", event sanitization, report) and the
 * `banyancode telemetry agent-report|agent-export` command surface
 * (`packages/opencode/src/cli/cmd/telemetry.ts`).
 *
 * Storage is the plugin's own host KV (`ctx.storage`), namespaced under
 * `agent-telemetry:`, so events survive restarts without touching the shared
 * project database schema. Nothing is ever sent off-machine: v1 only exported
 * locally (stdout JSONL / report), and so does this port.
 */

export const AGENT_TELEMETRY_PREFIX = "agent-telemetry:"
export const AGENT_TELEMETRY_KEY_FILE = "agent-efficiency-telemetry.key"
export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_MAX_EVENTS = 100_000

const STATUS = ["started", "succeeded", "failed", "aborted"] as const

export type AgentEfficiencyEventType =
  | "run.started"
  | "run.finished"
  | "run.failed"
  | "run.aborted"
  | "agent.spawned"
  | "agent.started"
  | "agent.finished"
  | "agent.failed"
  | "agent.aborted"
  | "model.started"
  | "model.finished"
  | "model.failed"
  | "model.aborted"
  | "tool.started"
  | "tool.finished"
  | "tool.failed"
  | "finding.recorded"
  | "finding.delivered"
  | "finding.consumed"
  | "finding.cited"
  | "finding.verified"
  | "finding.rejected"
  | "outcome.recorded"

export const AgentEfficiencyEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  eventID: Schema.String,
  eventType: Schema.String,
  occurredAt: Schema.Number,
  runID: Schema.String,
  sessionID: Schema.optional(Schema.String),
  parentSessionID: Schema.optional(Schema.String),
  rootSessionID: Schema.optional(Schema.String),
  agentInstanceID: Schema.optional(Schema.String),
  agentRole: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
  taskID: Schema.optional(Schema.String),
  benchmarkID: Schema.optional(Schema.String),
  experimentID: Schema.optional(Schema.String),
  experimentVariant: Schema.optional(Schema.String),
  modelCallID: Schema.optional(Schema.String),
  toolCallID: Schema.optional(Schema.String),
  findingID: Schema.optional(Schema.String),
  parentEventID: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(STATUS)),
  durationMs: Schema.optional(Schema.Number),
  errorCategory: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Banyan.AgentEfficiencyEvent" })

export type AgentEfficiencyEvent = typeof AgentEfficiencyEvent.Type

export type Filter = {
  readonly runID?: string
  readonly sessionID?: string
  readonly since?: number
  readonly limit?: number
}

// ── key file + local id ────────────────────────────────────────────────────

export const isValidAgentTelemetryKey = (key: string): boolean => /^[0-9a-f]{64}$/i.test(key)

/**
 * Port of v1 `loadAgentTelemetryKey`: an explicit `BANYANCODE_AGENT_TELEMETRY_KEY`
 * wins, otherwise a 64-hex key is created once in the state dir and reused.
 * The file is 0600 and the lock stops two first runs from generating two ids.
 */
export const loadAgentTelemetryKey = (
  filePath: string,
  configured = process.env.BANYANCODE_AGENT_TELEMETRY_KEY,
): string => {
  if (configured !== undefined && isValidAgentTelemetryKey(configured)) return configured
  const readValid = (): string | undefined => {
    try {
      const existing = readFileSync(filePath, "utf8").trim()
      return isValidAgentTelemetryKey(existing) ? existing : undefined
    } catch {
      return undefined
    }
  }
  const existing = readValid()
  if (existing !== undefined) return existing

  const lockPath = `${filePath}.lock`
  const generated = randomBytes(32).toString("hex")
  const owner = `${process.pid}:${randomUUID()}`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch {
    // parent may already exist or be unwritable; openSync reports the latter
  }
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const raced = readValid()
    if (raced !== undefined) return raced
    try {
      const lock = openSync(lockPath, "wx", 0o600)
      let wroteOwner = false
      try {
        writeFileSync(lockPath, owner, { encoding: "utf8", mode: 0o600, flag: "w" })
        wroteOwner = true
        const afterLock = readValid()
        if (afterLock !== undefined) return afterLock
        try {
          renameSync(filePath, `${filePath}.corrupt-${randomBytes(8).toString("hex")}`)
        } catch {
          // no corrupt file
        }
        try {
          writeFileSync(filePath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" })
        } catch {
          // another writer won the race; read it below
        }
        const winner = readValid()
        if (winner !== undefined) return winner
      } finally {
        closeSync(lock)
        try {
          if (!wroteOwner || readFileSync(lockPath, "utf8").trim() === owner) unlinkSync(lockPath)
        } catch {
          // lock already gone
        }
      }
    } catch {
      try {
        const pid = Number(readFileSync(lockPath, "utf8").trim().split(":", 1)[0])
        let alive = true
        try {
          process.kill(pid, 0)
        } catch {
          alive = false
        }
        if (pid > 0 && !alive && Date.now() - statSync(lockPath).mtimeMs > 5_000) unlinkSync(lockPath)
      } catch {
        // lock contended or already removed
      }
      // Small sleep without pulling a timer dependency into the key path.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  throw new Error("Unable to persist the BanyanCode agent telemetry key")
}

/** Stable HMAC local id: raw IDs never leave the machine. */
export const localId = (key: string, prefix: string, value: string): string =>
  `${prefix}-${createHmac("sha256", key).update(value).digest("hex").slice(0, 32)}`

// ── sanitization (verbatim policy from v1) ─────────────────────────────────

const SENSITIVE_KEY =
  /prompt|completion|reasoning|instruction|argument|input|output|result|credential|secret|token|path|file|hostname|username|device|provider.?response/i
const SAFE_NUMERIC_KEY = /(?:tokens|cost|count|bytes|size|ms|retry_count)$/i
const SAFE_STRING_KEY =
  /^(provider|requested_model|response_model|stop_reason|tool_name|model|outcome|error_category|parent_agent|proxy_status)$/
const SAFE_EVENT_ID = /^[A-Za-z0-9:_.-]{1,256}$/
const SAFE_RUN_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|ses_[A-Za-z0-9_-]{1,120}|run-[0-9a-f]{32})$/i
const EMBEDDED_PATH = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|[\s"'=:(])(?:\.\.?|home|users?|tmp|var|etc|private|workspace|packages|src)[\\/])/i
const EMBEDDED_MACHINE_ID = /\b(?:host(?:name)?|user(?:name)?|machine|device|computer)(?:[-_ ]?(?:id|name))?\s*[:=]/i

const sanitizeValue = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") {
    return key !== undefined && SAFE_STRING_KEY.test(key) && !EMBEDDED_PATH.test(value) && !EMBEDDED_MACHINE_ID.test(value)
      ? value.slice(0, 512)
      : undefined
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined)
  if (!value || typeof value !== "object") return undefined
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => {
        if (typeof item === "number") return SAFE_NUMERIC_KEY.test(key)
        if (typeof item === "string") return SAFE_STRING_KEY.test(key) && !SENSITIVE_KEY.test(key)
        return !SENSITIVE_KEY.test(key)
      })
      .map(([key, item]) => [key, sanitizeValue(item, key)] as const)
      .filter(([, item]) => item !== undefined),
  )
}

export const sanitizeAgentEfficiencyEvent = (event: AgentEfficiencyEvent, key: string): AgentEfficiencyEvent => ({
  ...event,
  eventID: SAFE_EVENT_ID.test(event.eventID) ? event.eventID : localId(key, "event", event.eventID),
  runID: SAFE_RUN_ID.test(event.runID) ? event.runID : localId(key, "run", event.runID),
  eventType: event.eventType,
  durationMs: event.durationMs === undefined ? undefined : Math.max(0, Math.floor(event.durationMs)),
  metadata:
    event.metadata === undefined
      ? undefined
      : (sanitizeValue(event.metadata) as Record<string, unknown> | undefined),
})

const isTerminal = (event: AgentEfficiencyEvent): boolean =>
  event.status === "succeeded" ||
  event.status === "failed" ||
  event.status === "aborted" ||
  event.eventType === "outcome.recorded" ||
  /\.(finished|failed|aborted)$/.test(event.eventType)

// ── store (host KV) ────────────────────────────────────────────────────────

export interface StoreOptions {
  readonly keyFile?: string
  readonly configuredKey?: string
  readonly now?: () => number
}

const defaultKeyFile = () => join(Global.Path.state, AGENT_TELEMETRY_KEY_FILE)

const keyOf = (event: AgentEfficiencyEvent): string =>
  `${AGENT_TELEMETRY_PREFIX}${String(event.occurredAt).padStart(14, "0")}:${event.eventID}`

const decode = (value: unknown): AgentEfficiencyEvent | undefined => {
  try {
    const parsed = Schema.decodeUnknownOption(AgentEfficiencyEvent)(value)
    return parsed._tag === "Some" ? parsed.value : undefined
  } catch {
    return undefined
  }
}

export interface AgentTelemetryStore {
  readonly record: (event: AgentEfficiencyEvent) => Effect.Effect<void>
  readonly list: (filter?: Filter) => Effect.Effect<ReadonlyArray<AgentEfficiencyEvent>>
  readonly count: () => Effect.Effect<number>
  readonly prune: (input?: { readonly retentionMs?: number; readonly maxEvents?: number }) => Effect.Effect<void>
  readonly key: () => string
}

export const makeAgentTelemetryStore = (storage: Context["storage"], options: StoreOptions = {}): AgentTelemetryStore => {
  const now = options.now ?? Date.now
  const keyFile = options.keyFile ?? defaultKeyFile()
  let cachedKey: string | undefined
  const key = (): string => {
    if (cachedKey !== undefined) return cachedKey
    try {
      cachedKey = loadAgentTelemetryKey(keyFile, options.configuredKey)
    } catch {
      // Never let a key-file failure break the session; this process still
      // gets a stable local id, just not one shared across restarts.
      cachedKey = randomBytes(32).toString("hex")
    }
    return cachedKey
  }

  const scanAll = (): Effect.Effect<ReadonlyArray<AgentEfficiencyEvent>> =>
    Effect.gen(function* () {
      const out: AgentEfficiencyEvent[] = []
      let after: string | undefined
      do {
        const page = yield* storage.scan({ prefix: AGENT_TELEMETRY_PREFIX, ...(after === undefined ? {} : { after }), limit: 200 })
        for (const entry of page.entries) {
          const event = decode(entry.value)
          if (event !== undefined) out.push(event)
        }
        after = page.next
      } while (after !== undefined)
      return out
    }).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<AgentEfficiencyEvent>)))

  const record: AgentTelemetryStore["record"] = (event) =>
    Effect.gen(function* () {
      const sanitized = sanitizeAgentEfficiencyEvent(event, key())
      yield* storage.set(keyOf(sanitized), { ...sanitized, schemaVersion: 1 } as never)
    }).pipe(Effect.catchCause(() => Effect.void))

  const list: AgentTelemetryStore["list"] = (filter) =>
    scanAll().pipe(
      Effect.map((events) =>
        events
          .filter((event) => filter?.runID === undefined || event.runID === filter.runID)
          .filter((event) => filter?.sessionID === undefined || event.sessionID === filter.sessionID)
          .filter((event) => filter?.since === undefined || event.occurredAt >= filter.since)
          .sort((a, b) => a.occurredAt - b.occurredAt || a.eventID.localeCompare(b.eventID))
          .slice(0, filter?.limit ?? Number.POSITIVE_INFINITY),
      ),
    )

  const prune: AgentTelemetryStore["prune"] = (input) =>
    Effect.gen(function* () {
      const retentionMs = Math.max(0, input?.retentionMs ?? DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      const maxEvents = Math.max(1, Math.floor(input?.maxEvents ?? DEFAULT_MAX_EVENTS))
      const cutoff = now() - retentionMs
      const events = yield* scanAll()
      const sorted = [...events].sort((a, b) => b.occurredAt - a.occurredAt || b.eventID.localeCompare(a.eventID))
      const kept: AgentEfficiencyEvent[] = []
      let nonTerminal = 0
      for (const event of sorted) {
        if (event.occurredAt <= cutoff && !isTerminal(event)) {
          yield* storage.remove(keyOf(event)).pipe(Effect.catchCause(() => Effect.void))
          continue
        }
        if (!isTerminal(event)) {
          nonTerminal += 1
          if (nonTerminal > maxEvents) {
            yield* storage.remove(keyOf(event)).pipe(Effect.catchCause(() => Effect.void))
            continue
          }
        }
        kept.push(event)
      }
    }).pipe(Effect.catchCause(() => Effect.void))

  return {
    record,
    list,
    count: () => scanAll().pipe(Effect.map((events) => events.length)),
    prune,
    key,
  }
}

// ── report / export (v1 `agent-report` / `agent-export`) ───────────────────

export const AgentRoleReport = Schema.Struct({
  events: Schema.Number,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cost: Schema.NullOr(Schema.Number),
  cachedInputTokens: Schema.NullOr(Schema.Number),
  uncachedInputTokens: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Banyan.AgentRoleReport" })

export const AgentReport = Schema.Struct({
  eventCount: Schema.Number,
  runCount: Schema.Number,
  agentCount: Schema.Number,
  modelCallCount: Schema.Number,
  toolCallCount: Schema.Number,
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  uncachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalCost: Schema.Number,
  realizedCacheReadRatio: Schema.NullOr(Schema.Number),
  byRole: Schema.Record(Schema.String, AgentRoleReport),
}).annotate({ identifier: "Banyan.AgentReport" })

export type AgentReport = typeof AgentReport.Type

const numberOf = (event: AgentEfficiencyEvent, key: string): number | undefined => {
  const value = event.metadata?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Pure port of v1 `summarizeAgentEvents`. */
export const summarizeAgentEvents = (events: ReadonlyArray<AgentEfficiencyEvent>): AgentReport => {
  const runs = new Set<string>()
  const agents = new Set<string>()
  let modelCallCount = 0
  let toolCallCount = 0
  let inputTokens = 0
  let outputTokens = 0
  let totalCost = 0
  let cachedInputTokens = 0
  let uncachedInputTokens = 0
  let cacheEvents = 0
  let cacheComplete = true
  const byRole = new Map<
    string,
    { events: number; inputTokens: number; outputTokens: number; cost: number; cached: number; uncached: number; cacheComplete: boolean }
  >()

  for (const event of events) {
    runs.add(event.runID)
    if (event.agentInstanceID !== undefined) agents.add(event.agentInstanceID)
    if (event.eventType.startsWith("model.")) modelCallCount += 1
    if (event.eventType.startsWith("tool.")) toolCallCount += 1

    const role = event.agentRole ?? "unknown"
    const current = byRole.get(role) ?? {
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      cached: 0,
      uncached: 0,
      cacheComplete: true,
    }
    current.events += 1

    const input = numberOf(event, "input_tokens")
    const output = numberOf(event, "output_tokens")
    const cost = numberOf(event, "cost")
    const cached = numberOf(event, "cached_input_tokens")
    const uncached = numberOf(event, "uncached_input_tokens")
    if (input !== undefined) {
      inputTokens += input
      current.inputTokens += input
    }
    if (output !== undefined) {
      outputTokens += output
      current.outputTokens += output
    }
    if (cost !== undefined) {
      totalCost += cost
      current.cost += cost
    }
    if (cached !== undefined) {
      cachedInputTokens += cached
      current.cached += cached
    }
    if (uncached !== undefined) {
      uncachedInputTokens += uncached
      current.uncached += uncached
    }
    if (event.eventType.startsWith("model.") && event.eventType !== "model.started") {
      cacheEvents += 1
      if (input === undefined || cached === undefined) {
        cacheComplete = false
        current.cacheComplete = false
      }
    }
    byRole.set(role, current)
  }

  return {
    eventCount: events.length,
    runCount: runs.size,
    agentCount: agents.size,
    modelCallCount,
    toolCallCount,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    totalCost,
    realizedCacheReadRatio:
      cacheEvents > 0 && cacheComplete && inputTokens > 0 ? Number((cachedInputTokens / inputTokens).toFixed(4)) : null,
    byRole: Object.fromEntries(
      [...byRole.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, value]) => [
        role,
        {
          events: value.events,
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          cost: value.cost,
          cachedInputTokens: value.cacheComplete ? value.cached : null,
          uncachedInputTokens: value.cacheComplete ? value.uncached : null,
        },
      ]),
    ),
  }
}

/** v1 `agent-export`: sanitized JSONL, one event per line. */
export const exportAgentEvents = (events: ReadonlyArray<AgentEfficiencyEvent>): string =>
  events.map((event) => JSON.stringify(event)).join("\n")
