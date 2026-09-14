export * as CodegraphReadiness from "./codegraph-readiness"

import { Cause, Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import { CodegraphBuildService } from "./codegraph-build-service"
import { CodegraphRepo, CODEGRAPH_SCHEMA_VERSION } from "./codegraph-repo"
import { STALENESS_AGE_HIGH_MS, STALENESS_COVERAGE_HIGH } from "./graph-staleness"
import { WorkspaceIdentity } from "./workspace-identity"
import type { CodegraphMeta } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000
// Phase 2: default auto-rebuild threshold. Honours the value exported
// from graph-staleness.ts so the warning surface and the rebuild trigger
// share one source of truth. Callers can override per `ensureReady` call.
const DEFAULT_THRESHOLD_MS = STALENESS_AGE_HIGH_MS

// Phase 8 follow-up (auto-build false triggers): canonicalize a root the same
// way `WorkspaceIdentity.identityForRoot` does at build time (realpath, with a
// resolve fallback) and, on win32, case-fold the comparison. The indexed_root
// stored by a build is the realpath'd canonical spelling, so a caller passing a
// different casing / a symlink / a junction spelling of the SAME workspace must
// not be treated as a root change — that was forcing a full rebuild on every
// tool call.
const canonicalRoot = (p: string): string => {
  const real = WorkspaceIdentity.sanitizeRoot(p)
  return process.platform === "win32" ? real.toLowerCase() : real
}

export const ReadinessResult = Schema.Struct({
  reason: Schema.Literals(["ready", "missing", "stale", "building", "failed"]),
  autoBuilt: Schema.Boolean,
  graphBuiltAt: Schema.optional(Schema.Number),
  graphVersion: Schema.optional(Schema.Number),
  graphCoverage: Schema.optional(Schema.Number),
  totalFiles: Schema.optional(Schema.Number),
  indexedFiles: Schema.optional(Schema.Number),
  changedFiles: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  warning: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/CodegraphReadiness" })

export type ReadinessResult = typeof ReadinessResult.Type

// Readiness classification split: needsBuild (missing meta / empty table,
// reconciled with force:false), needsSync (per-file drift, background only),
// forceReindex (schema mismatch — the sole force:true trigger), routingError
// (indexed_root mismatch — a routing failure, never a rebuild).
export const classifyReadiness = (input: {
  readonly meta: CodegraphMeta | undefined
  readonly fileCount: number
  readonly root: string
}): {
  readonly needsBuild: boolean
  readonly forceReindex: boolean
  readonly routingError: string | undefined
} => {
  if (!input.meta) return { needsBuild: true, forceReindex: false, routingError: undefined }
  if (input.fileCount === 0) return { needsBuild: true, forceReindex: false, routingError: undefined }
  if (input.meta.schemaVersion !== CODEGRAPH_SCHEMA_VERSION) {
    return { needsBuild: false, forceReindex: true, routingError: undefined }
  }
  if (
    input.meta.indexedRoot !== undefined &&
    canonicalRoot(input.meta.indexedRoot) !== canonicalRoot(input.root)
  ) {
    return {
      needsBuild: false,
      forceReindex: false,
      routingError: `indexed_root mismatch: store holds '${input.meta.indexedRoot}' but caller resolved '${input.root}'`,
    }
  }
  return { needsBuild: false, forceReindex: false, routingError: undefined }
}

export interface Interface {
  readonly ensureReady: (input: {
    root: string
    // Cached-reconciliation warning interval: age beyond it attaches a
    // warning, never a rebuild. Defaults to the high staleness threshold.
    thresholdMs?: number
  }) => Effect.Effect<ReadinessResult, never, never>
  readonly status: () => Effect.Effect<ReadinessResult, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphReadiness") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const metaFields = (m: CodegraphMeta | undefined) => ({
  graphBuiltAt: m?.graphBuiltAt,
  graphVersion: m?.graphVersion,
  graphCoverage: m?.graphCoverage,
  totalFiles: m?.totalFiles,
})

/**
 * Pure persisted-status derivation shared by `CodegraphReadiness.status()`
 * and the root-aware `global.codegraphStatus` HTTP handler. Distinguishes
 * `missing` (no meta row), `stale` (coverage < 0.5 OR age > the high
 * staleness threshold, with the warning attached), and `ready` (healthy)
 * instead of always returning `ready` whenever a meta row exists.
 */
export const statusFromMeta = (meta: CodegraphMeta | undefined): ReadinessResult => {
  if (!meta) {
    return { reason: "missing", autoBuilt: false }
  }
  const ageMs = Date.now() - meta.graphBuiltAt
  const coverageLow = (meta.graphCoverage ?? 0) < STALENESS_COVERAGE_HIGH
  if (coverageLow || ageMs > STALENESS_AGE_HIGH_MS) {
    const warning = coverageLow
      ? `graph coverage is ${((meta.graphCoverage ?? 0) * 100).toFixed(0)}%; large parts of the codebase are unindexed`
      : `graph is ${Math.floor(ageMs / DAY_MS)} day${
          Math.floor(ageMs / DAY_MS) !== 1 ? "s" : ""
        } old; consider rebuilding before editing`
    return { reason: "stale", autoBuilt: false, ...metaFields(meta), warning }
  }
  return { reason: "ready", autoBuilt: false, ...metaFields(meta) }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const noop: ReadinessResult = { reason: "ready", autoBuilt: false }
      return Service.of({
        ensureReady: () => Effect.succeed(noop),
        status: () => Effect.succeed(noop),
      })
    }

    const buildService = yield* CodegraphBuildService.Service
    const repo = yield* CodegraphRepo.Service
    const inflight = yield* Ref.make<Map<string, Deferred.Deferred<ReadinessResult, never>>>(new Map())

    const runReadiness = (
      root: string,
      thresholdMs: number,
    ): Effect.Effect<ReadinessResult, never, never> =>
      Effect.gen(function* () {
        const startMs = Date.now()
        const meta = yield* repo.getMeta()
        const fileCount = yield* repo.countFiles()
        const staleCount = meta ? yield* repo.countStaleFiles() : 0
        const classification = classifyReadiness({ meta, fileCount, root })

        if (classification.routingError) {
          return {
            reason: "failed",
            autoBuilt: false,
            ...metaFields(meta),
            changedFiles: staleCount,
            error: classification.routingError,
          } satisfies ReadinessResult
        }

        // thresholdMs is the cached-reconciliation warning interval: age
        // beyond it is advisory only, never a rebuild trigger.
        const ageMs = meta?.graphBuiltAt ? Date.now() - meta.graphBuiltAt : Infinity
        const ageWarning =
          meta?.graphBuiltAt && ageMs > thresholdMs
            ? `graph is ${Math.floor(ageMs / DAY_MS)} day${
                Math.floor(ageMs / DAY_MS) !== 1 ? "s" : ""
              } old; consider rebuilding before editing`
            : undefined

        if (!classification.needsBuild && !classification.forceReindex) {
          const result: ReadinessResult = {
            reason: "ready",
            autoBuilt: false,
            ...metaFields(meta),
            changedFiles: staleCount,
            ...(ageWarning !== undefined ? { warning: ageWarning } : {}),
          }
          return result
        }

        yield* buildService.start({ root, force: classification.forceReindex })

        let currentStatus = yield* buildService.status()
        let polls = 0
        while (currentStatus.status === "running" && polls < 60) {
          yield* Effect.sleep("500 millis")
          currentStatus = yield* buildService.status()
          polls++
        }
        if (currentStatus.status === "running") {
          return {
            reason: "building",
            autoBuilt: true,
            durationMs: Date.now() - startMs,
            ...metaFields(meta),
          } satisfies ReadinessResult
        }

        const durationMs = Date.now() - startMs
        const freshMeta = yield* repo.getMeta()
        const indexedFiles = currentStatus.result?.indexed

        if (currentStatus.status === "completed") {
          const result: ReadinessResult = {
            reason: "ready",
            autoBuilt: true,
            durationMs,
            indexedFiles,
            ...metaFields(freshMeta),
          }
          return result
        }

        if (currentStatus.status === "cancelled") {
          const result: ReadinessResult = {
            reason: "failed",
            autoBuilt: true,
            durationMs,
            error: "cancelled",
            ...metaFields(freshMeta),
          }
          return result
        }

        // failed or any other terminal state
        const result: ReadinessResult = {
          reason: "failed",
          autoBuilt: true,
          durationMs,
          error: currentStatus.error ?? "unknown build error",
          ...metaFields(freshMeta),
        }
        return result
      })

    type Reservation = {
      readonly deferred: Deferred.Deferred<ReadinessResult, never>
      readonly isOwner: boolean
    }

    const ensureReady: Interface["ensureReady"] = Effect.fn("CodegraphReadiness.ensureReady")(
      function* (input) {
        const root = canonicalRoot(input.root)
        const thresholdMs = input.thresholdMs ?? DEFAULT_THRESHOLD_MS

        // Create a candidate Deferred eagerly. If we lose the race we still wait
        // on the winner's Deferred — our candidate is GC'd.
        const candidate = yield* Deferred.make<ReadinessResult, never>()

        const winner: Reservation = yield* Ref.modify(inflight, (m) => {
          const existing = m.get(root)
          if (existing) {
            const r: Reservation = { deferred: existing, isOwner: false }
            return [r, m]
          }
          const next = new Map(m)
          next.set(root, candidate)
          const r: Reservation = { deferred: candidate, isOwner: true }
          return [r, next]
        })

        if (winner.isOwner) {
          // Sole owner: fork the readiness work. Settle the Deferred ourselves
          // and clean up the inflight slot whether the work succeeds or fails.
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              const result = yield* runReadiness(root, thresholdMs).pipe(
                Effect.catchCause((cause) => {
                  const err = Cause.squash(cause)
                  const message = err instanceof Error ? err.message : String(err)
                  const fallback: ReadinessResult = {
                    reason: "failed",
                    autoBuilt: true,
                    error: message,
                  }
                  return Effect.succeed(fallback)
                }),
              )
              yield* Deferred.succeed(winner.deferred, result)
            }).pipe(
              Effect.ensuring(
                Ref.update(inflight, (m) => {
                  const next = new Map(m)
                  next.delete(root)
                  return next
                }),
              ),
            ),
          )
        }

        return yield* Deferred.await(winner.deferred)
      },
    )

    const status: Interface["status"] = () =>
      Effect.gen(function* () {
        const meta = yield* repo.getMeta()
        return statusFromMeta(meta)
      })

    return Service.of({ ensureReady, status })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphBuildService.defaultLayer),
  Layer.provide(CodegraphRepo.defaultLayer),
)
