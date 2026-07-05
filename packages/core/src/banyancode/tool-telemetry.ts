export * as ToolTelemetry from "./tool-telemetry"

import { Context, Effect, Layer, Ref } from "effect"
import path from "node:path"
import { appendFile, mkdir } from "node:fs/promises"
import { FSUtil } from "../fs-util"

export type ToolRuntimeEventKind = "raw" | "normalized" | "validated" | "executed" | "failed"

export type ToolLintWarning = {
  readonly kind:
    | "alias"
    | "null-removal"
    | "default-fill"
    | "type-coerce"
    | "missing-required"
    | "low-confidence"
  readonly field: string
  readonly fromValue: unknown
  readonly toValue?: unknown
  readonly confidence: number
  readonly autoFixAvailable: boolean
  readonly suggestedFix?: string
}

export type ToolRuntimeEvent = {
  readonly kind: ToolRuntimeEventKind
  readonly toolID: string
  readonly sessionID: string
  readonly agent: string
  readonly modelID: string
  readonly toolCallID: string
  readonly rawInput?: unknown
  readonly normalizedInput?: unknown
  readonly validatedInput?: unknown
  readonly repairs: readonly string[]
  readonly warnings: readonly ToolLintWarning[]
  readonly startedAt: number
  readonly finishedAt?: number
  readonly latencyMs?: number
  readonly success?: boolean
  readonly errorMessage?: string
  readonly nextToolID?: string
}

export type AliasCount = readonly { readonly from: string; readonly to: string; readonly count: number }[]
export type ErrorCount = readonly { readonly message: string; readonly count: number }[]
export type FollowupCount = readonly { readonly toolID: string; readonly count: number }[]

export type ToolQualityReport = {
  readonly toolID: string
  readonly callCount: number
  readonly successCount: number
  readonly failureCount: number
  readonly successRate: number
  readonly validationFailureCount: number
  readonly validationFailureRate: number
  readonly averageRepairsPerCall: number
  readonly averageLatencyMs: number
  readonly p50LatencyMs: number
  readonly p99LatencyMs: number
  readonly mostCommonAlias: AliasCount
  readonly mostCommonError: ErrorCount
  readonly mostCommonFollowup: FollowupCount
  readonly abandonmentRate: number
}

export interface Interface {
  readonly recordEvent: (event: ToolRuntimeEvent) => Effect.Effect<void, never, never>
  readonly aggregate: (input?: {
    readonly toolID?: string
    readonly since?: number
  }) => Effect.Effect<ToolQualityReport, never, never>
  readonly flush: (input: { readonly worktree: string }) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/tool-telemetry") {}

const emptyReport = (toolID: string): ToolQualityReport => ({
  toolID,
  callCount: 0,
  successCount: 0,
  failureCount: 0,
  successRate: 0,
  validationFailureCount: 0,
  validationFailureRate: 0,
  averageRepairsPerCall: 0,
  averageLatencyMs: 0,
  p50LatencyMs: 0,
  p99LatencyMs: 0,
  mostCommonAlias: [],
  mostCommonError: [],
  mostCommonFollowup: [],
  abandonmentRate: 0,
})

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? 0
}

const traceDir = (worktree: string) => path.join(worktree, ".banyancode", "trace")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const storeRef = yield* Ref.make(new Map<string, ToolRuntimeEvent[]>())

    const recordEvent: Interface["recordEvent"] = (event) =>
      Ref.update(storeRef, (m) => {
        const arr = m.get(event.sessionID) ?? []
        const next = new Map(m)
        next.set(event.sessionID, [...arr, event])
        return next
      })

    const aggregate: Interface["aggregate"] = (input) =>
      Effect.gen(function* () {
        const target = input?.toolID
        const since = input?.since ?? 0
        const snap = yield* Ref.get(storeRef)
        const all = [...snap.values()].flat()
        const filtered = all.filter((e) => e.toolID.length > 0).filter((e) => {
          if (target && e.toolID !== target) return false
          if (since > 0 && e.startedAt < since) return false
          return true
        })
        const reportToolID = target ?? "all"
        if (filtered.length === 0) return emptyReport(reportToolID)

        const calls = filtered.filter((e) => e.kind === "executed" || e.kind === "failed")
        const callCount = calls.length
        const successCount = filtered.filter((e) => e.kind === "executed").length
        const failureCount = filtered.filter((e) => e.kind === "failed").length
        const validationFailureCount = filtered.filter(
          (e) => e.kind === "failed" && typeof e.errorMessage === "string" && /Invalid tool input/.test(e.errorMessage),
        ).length

        const latencies = calls
          .map((e) => e.latencyMs ?? 0)
          .filter((n) => n > 0)
          .sort((a, b) => a - b)
        const totalLatency = latencies.reduce((a, b) => a + b, 0)
        const totalRepairs = filtered.reduce((sum, e) => sum + e.repairs.length, 0)

        return {
          toolID: reportToolID,
          callCount,
          successCount,
          failureCount,
          successRate: callCount > 0 ? successCount / callCount : 0,
          validationFailureCount,
          validationFailureRate: callCount > 0 ? validationFailureCount / callCount : 0,
          averageRepairsPerCall: callCount > 0 ? totalRepairs / callCount : 0,
          averageLatencyMs: callCount > 0 ? totalLatency / callCount : 0,
          p50LatencyMs: percentile(latencies, 50),
          p99LatencyMs: percentile(latencies, 99),
          mostCommonAlias: [],
          mostCommonError: [],
          mostCommonFollowup: [],
          abandonmentRate: 0,
        }
      })

    const flush: Interface["flush"] = ({ worktree }) =>
      Effect.gen(function* () {
        const snap = yield* Ref.get(storeRef)
        if (snap.size === 0) return
        const dir = traceDir(worktree)
        yield* fs.ensureDir(dir).pipe(Effect.orDie)
        const next = new Map(snap)
        for (const [sessionID, events] of snap.entries()) {
          if (events.length === 0) continue
          const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
          const filePath = path.join(dir, `${sessionID}.jsonl`)
          yield* Effect.tryPromise({
            try: () => appendFile(filePath, lines, "utf8"),
            catch: (err) => new Error(`tool-telemetry flush failed: ${err instanceof Error ? err.message : String(err)}`),
          }).pipe(Effect.orDie)
          next.delete(sessionID)
        }
        yield* Ref.set(storeRef, next)
      })

    return Service.of({ recordEvent, aggregate, flush })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(Layer.provide(FSUtil.defaultLayer))
