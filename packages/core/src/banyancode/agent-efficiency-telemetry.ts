export * as AgentEfficiencyTelemetry from "./agent-efficiency-telemetry"

import { Context, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from "effect"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Global } from "../global"
import { BanyanConfigService } from "./banyan-config"
import { AgentEfficiencyTelemetryRepo } from "./agent-efficiency-telemetry-repo"

export type TelemetryStatus = "started" | "succeeded" | "failed" | "aborted"
export type TelemetryMetadata = { readonly _v: 1; readonly data: Record<string, unknown> }
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

export type AgentEfficiencyEvent = {
  readonly schemaVersion: 1
  readonly eventID: string
  readonly eventType: AgentEfficiencyEventType
  readonly occurredAt: number
  readonly runID: string
  readonly sessionID?: string
  readonly parentSessionID?: string
  readonly rootSessionID?: string
  readonly agentInstanceID?: string
  readonly agentRole?: string
  readonly depth?: number
  readonly taskID?: string
  readonly benchmarkID?: string
  readonly experimentID?: string
  readonly experimentVariant?: string
  readonly modelCallID?: string
  readonly toolCallID?: string
  readonly findingID?: string
  readonly parentEventID?: string
  readonly status?: TelemetryStatus
  readonly durationMs?: number
  readonly errorCategory?: string
  readonly metadata?: Record<string, unknown>
}

const SENSITIVE_KEY = /prompt|completion|reasoning|instruction|argument|input|output|result|credential|secret|token|path|file|hostname|username|device|provider.?response/i
const SAFE_NUMERIC_KEY = /(?:tokens|cost|count|bytes|size|ms|retry_count)$/i
const SAFE_STRING_KEY = /^(provider|requested_model|response_model|stop_reason|tool_name|model|outcome|error_category|parent_agent|proxy_status)$/
const SAFE_EVENT_ID = /^[A-Za-z0-9:_.-]{1,256}$/
const SAFE_RUN_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|ses_[A-Za-z0-9_-]{1,120}|run-[0-9a-f]{32})$/i
const EMBEDDED_PATH = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|[\s"'=:(])(?:\.\.?|home|users?|tmp|var|etc|private|workspace|packages|src)[\\/])/i
const EMBEDDED_MACHINE_ID = /\b(?:host(?:name)?|user(?:name)?|machine|device|computer)(?:[-_ ]?(?:id|name))?\s*[:=]/i
export const loadAgentTelemetryKey = (filePath: string, configured = process.env.BANYANCODE_AGENT_TELEMETRY_KEY) => {
  const isValid = (key: string) => /^[0-9a-f]{64}$/i.test(key)
  if (configured && isValid(configured)) return configured
  const readValid = () => {
    try {
      const existing = readFileSync(filePath, "utf8").trim()
      return isValid(existing) ? existing : undefined
    } catch {
      return undefined
    }
  }
  const existing = readValid()
  if (existing) return existing
  const lockPath = `${filePath}.lock`
  const generated = randomBytes(32).toString("hex")
  const owner = `${process.pid}:${randomUUID()}`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch {}
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const raced = readValid()
    if (raced) return raced
    try {
      const lock = openSync(lockPath, "wx", 0o600)
      let wroteOwner = false
      try {
        writeFileSync(lockPath, owner, { encoding: "utf8", mode: 0o600, flag: "w" })
        wroteOwner = true
        const afterLock = readValid()
        if (afterLock) return afterLock
        try {
          renameSync(filePath, `${filePath}.corrupt-${randomBytes(8).toString("hex")}`)
        } catch {}
        try {
          writeFileSync(filePath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" })
        } catch {}
        const winner = readValid()
        if (winner) return winner
      } finally {
        closeSync(lock)
        try {
          if (!wroteOwner || readFileSync(lockPath, "utf8").trim() === owner) unlinkSync(lockPath)
        } catch {}
      }
    } catch {
      try {
        const lockOwner = readFileSync(lockPath, "utf8").trim()
        const pid = Number(lockOwner.split(":", 1)[0])
        let ownerAlive = true
        try {
          process.kill(pid, 0)
        } catch {
          ownerAlive = false
        }
        if (pid > 0 && !ownerAlive && Date.now() - statSync(lockPath).mtimeMs > 5_000) {
          if (readFileSync(lockPath, "utf8").trim() === lockOwner) unlinkSync(lockPath)
        }
      } catch {}
      const wait = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(wait, 0, 0, 5)
    }
  }
  throw new Error("Unable to persist BanyanCode agent telemetry key")
}

const LOCAL_ID_KEY = loadAgentTelemetryKey(join(Global.Path.banyan.state, "agent-efficiency-telemetry.key"))
const stableRedactedID = (prefix: string, value: string) =>
  `${prefix}-${createHmac("sha256", LOCAL_ID_KEY).update(value).digest("hex").slice(0, 32)}`

const sanitizeValue = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") return key && SAFE_STRING_KEY.test(key) && !EMBEDDED_PATH.test(value) && !EMBEDDED_MACHINE_ID.test(value) ? value.slice(0, 512) : undefined
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

export const sanitizeAgentEfficiencyEvent = (event: AgentEfficiencyEvent): AgentEfficiencyEvent => ({
  ...event,
  eventID: SAFE_EVENT_ID.test(event.eventID) ? event.eventID : stableRedactedID("event", event.eventID),
  runID: SAFE_RUN_ID.test(event.runID) ? event.runID : stableRedactedID("run", event.runID),
  durationMs: event.durationMs === undefined ? undefined : Math.max(0, Math.floor(event.durationMs)),
  metadata: event.metadata === undefined ? undefined : (sanitizeValue(event.metadata) as Record<string, unknown>),
})

const isTerminal = (event: AgentEfficiencyEvent) =>
  event.status === "succeeded" ||
  event.status === "failed" ||
  event.status === "aborted" ||
  event.eventType === "outcome.recorded" ||
  event.eventType.endsWith(".finished") ||
  event.eventType.endsWith(".failed") ||
  event.eventType.endsWith(".aborted")

export type Options = { readonly enabled?: boolean; readonly retentionMs?: number; readonly maxEvents?: number }

export interface Interface {
  readonly record: (event: AgentEfficiencyEvent) => Effect.Effect<void, never, never>
  readonly flush?: () => Effect.Effect<void, never, never>
  readonly recent: (input?: { readonly runID?: string; readonly sessionID?: string; readonly since?: number }) => Effect.Effect<readonly AgentEfficiencyEvent[], never, never>
  readonly count: () => Effect.Effect<number, never, never>
  readonly prune: () => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/AgentEfficiencyTelemetry") {}

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const repo = yield* AgentEfficiencyTelemetryRepo.Service
      const configOption = yield* Effect.serviceOption(BanyanConfigService.Service)
      const config = Option.isSome(configOption) ? yield* configOption.value.get() : undefined
      const enabled = options.enabled ?? config?.banyancode_agent_telemetry !== "off"
      const retentionDays = Math.max(0, config?.banyancode_agent_telemetry_retention_days ?? 30)
      const retentionMs = Math.max(0, Math.floor(options.retentionMs ?? retentionDays * 24 * 60 * 60 * 1000))
      const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? config?.banyancode_agent_telemetry_max_events ?? 100_000))
      const prune = () => (enabled ? repo.prune({ retentionMs, maxEvents }) : Effect.void)
      const queue = yield* Queue.bounded<AgentEfficiencyEvent>(256)
      const pending = yield* Ref.make(0)
      const persist = (event: AgentEfficiencyEvent) =>
        repo.append(event).pipe(Effect.catchCause(() => Effect.void))
      const drain = yield* Effect.forkScoped(
        Stream.fromQueue(queue).pipe(
          Stream.mapEffect(
            (event) => persist(event).pipe(Effect.ensuring(Ref.update(pending, (count) => Math.max(0, count - 1)))),
            { concurrency: 1 },
          ),
          Stream.runDrain,
        ),
      )
      const record = (event: AgentEfficiencyEvent) =>
        (enabled
          ? Effect.gen(function* () {
              const sanitized = sanitizeAgentEfficiencyEvent(event)
              yield* Ref.update(pending, (count) => count + 1)
              const offered = yield* Queue.offer(queue, sanitized).pipe(Effect.timeout("0 millis"), Effect.option)
              if (Option.isSome(offered)) return
              yield* Ref.update(pending, (count) => Math.max(0, count - 1))
              if (!isTerminal(sanitized)) return
              yield* Ref.update(pending, (count) => count + 1)
              yield* Effect.forkDetach(persist(sanitized).pipe(Effect.ensuring(Ref.update(pending, (count) => Math.max(0, count - 1))))).pipe(Effect.asVoid)
            })
          : Effect.void
        ).pipe(Effect.catchCause(() => Effect.void))
      yield* prune().pipe(Effect.catchCause(() => Effect.void))
      const flush = Effect.gen(function* () {
        while ((yield* Ref.get(pending)) > 0) yield* Effect.sleep("1 millis")
        yield* prune().pipe(Effect.catchCause(() => Effect.void))
      })
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* flush.pipe(Effect.timeout("5 seconds"), Effect.ignore)
          yield* Queue.shutdown(queue).pipe(Effect.ignore)
          yield* Fiber.interrupt(drain).pipe(Effect.ignore)
        }),
      )
      return Service.of({ record, flush: () => flush, recent: repo.list, count: repo.count, prune })
    }),
  )

export const defaultLayer = (options?: Options) =>
  layer(options).pipe(
    Layer.provide(AgentEfficiencyTelemetryRepo.defaultLayer),
    Layer.provide(BanyanConfigService.defaultLayer),
  )
