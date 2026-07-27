export * as CodegraphReadiness from "./codegraph-readiness"

import { Cause, Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import fs from "node:fs"
import path from "path"
import { CodegraphBuildService } from "./codegraph-build-service"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphMeta } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_THRESHOLD_MS = DAY_MS

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
    const lastRoot = yield* Ref.make<string | undefined>(undefined)

    const metaFields = (m: CodegraphMeta | undefined) => ({
      graphBuiltAt: m?.graphBuiltAt,
      graphVersion: m?.graphVersion,
      graphCoverage: m?.graphCoverage,
      totalFiles: m?.totalFiles,
    })

    const computeChangedFiles = (files: ReadonlyArray<{ path: string; indexedAt: number }>): number => {
      let changed = 0
      for (const file of files) {
        try {
          const stat = fs.statSync(file.path)
          if (stat.mtimeMs > file.indexedAt) changed++
        } catch {
          // file missing or inaccessible — skip
        }
      }
      return changed
    }

    const runReadiness = (
      root: string,
      thresholdMs: number,
    ): Effect.Effect<ReadinessResult, never, never> =>
      Effect.gen(function* () {
        const startMs = Date.now()
        const meta = yield* repo.getMeta()
        const files = yield* repo.listAllFiles()

        const changedFiles = meta && files.length > 0 ? computeChangedFiles(files) : 0

        const force = !meta || files.length === 0
        const ageMs = meta?.graphBuiltAt ? Date.now() - meta.graphBuiltAt : Infinity
        const needsRebuild = force || changedFiles > 0 || ageMs > thresholdMs

        if (!needsRebuild) {
          const result: ReadinessResult = {
            reason: "ready",
            autoBuilt: false,
            changedFiles,
            ...metaFields(meta),
          }
          return result
        }

        yield* buildService.start({ root, force })

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
            changedFiles,
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
            changedFiles,
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
          changedFiles,
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
        const root = path.resolve(input.root)
        const thresholdMs = input.thresholdMs ?? DEFAULT_THRESHOLD_MS

        yield* Ref.set(lastRoot, root)

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
        if (!meta) {
          const result: ReadinessResult = { reason: "missing", autoBuilt: false }
          return result
        }
        const result: ReadinessResult = {
          reason: "ready",
          autoBuilt: false,
          ...metaFields(meta),
        }
        return result
      })

    return Service.of({ ensureReady, status })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphBuildService.defaultLayer),
  Layer.provide(CodegraphRepo.defaultLayer),
)