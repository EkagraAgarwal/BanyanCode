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
const SEVEN_DAYS_MS = STALENESS_AGE_HIGH_MS

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

export interface Interface {
  readonly ensureReady: (input: {
    root: string
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
        // Only need to know whether any file row exists — COUNT(*) avoids
        // materializing the whole file table just to check emptiness.
        const fileCount = yield* repo.countFiles()
        // Phase 1 (freshness): per-file drift — rows whose mtime is newer
        // than their indexed_at. Surface it as `changedFiles` so callers
        // can see that files changed after the graph snapshot even when the
        // graph is structurally valid (meta present, files indexed, root
        // unchanged). Never a rebuild trigger; age stays advisory.
        const staleCount = meta ? yield* repo.countStaleFiles() : 0

        // Phase 2: rebuild triggers. The mtime heuristic is gone — content
        // hash is the real signal and CodegraphIndexer refreshes
        // `indexed_at` on cache hits (see `bumpIndexedAt`). We only force
        // a rebuild when the graph is structurally invalid (no meta,
        // empty file table) or when the indexed root/schema moved.
        const rootChanged = !!meta && meta.indexedRoot !== undefined && canonicalRoot(meta.indexedRoot) !== root
        const schemaStale = !!meta && meta.schemaVersion !== CODEGRAPH_SCHEMA_VERSION
        const force = !meta || fileCount === 0 || rootChanged || schemaStale

        // Phase 2: age is a WARNING, not a rebuild trigger.
        const ageMs = meta?.graphBuiltAt ? Date.now() - meta.graphBuiltAt : Infinity
        const ageWarning =
          meta?.graphBuiltAt && ageMs > SEVEN_DAYS_MS
            ? `graph is ${Math.floor(ageMs / DAY_MS)} day${
                Math.floor(ageMs / DAY_MS) !== 1 ? "s" : ""
              } old; consider rebuilding before editing`
            : undefined

        if (!force) {
          // Phase 2: shortcut the hot path. A usable graph exists and is
          // structurally valid — return `ready` immediately so caller
          // doesn't block on a 50-500ms poll loop. Drift is handled in the
          // background by CodegraphAutoUpdate.
          const result: ReadinessResult = {
            reason: "ready",
            autoBuilt: false,
            ...metaFields(meta),
            changedFiles: staleCount,
            ...(ageWarning !== undefined ? { warning: ageWarning } : {}),
          }
          return result
        }

        // Worth rebuilding. Suppress the old 24h tripping — honor the
        // caller's threshold only when one of the structural conditions
        // (missing meta, empty files, root change, schemaStale) is also
        // true. Without that, we'd ignore the threshold entirely.
        yield* buildService.start({ root, force: true })

        let currentStatus = yield* buildService.status()
        while (currentStatus.status === "running") {
          yield* Effect.sleep("500 millis")
          currentStatus = yield* buildService.status()
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
