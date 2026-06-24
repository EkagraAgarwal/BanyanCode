export * as CodegraphStaleness from "./codegraph-staleness"

import { Context, Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import * as Duration from "effect/Duration"
import * as Schedule from "effect/Schedule"
import { CodegraphRepo } from "./codegraph-repo"
import { FSUtil } from "../fs-util"
import type { CodegraphMeta } from "./types"

const StaleCheck = Schema.Struct({
  isStale: Schema.Boolean,
  filesChanged: Schema.Number,
  filesMissing: Schema.Number,
  filesTotal: Schema.Number,
  lastChecked: Schema.Number,
  reason: Schema.optional(Schema.String),
  graphBuiltAt: Schema.optional(Schema.Number),
  graphVersion: Schema.optional(Schema.Number),
  graphCoverage: Schema.optional(Schema.Number),
})
export { StaleCheck }

export interface Interface {
  readonly isStale: (input: { root: string; thresholdMs?: number }) => Effect.Effect<typeof StaleCheck.Type, never, never>
  readonly watch: (input: { root: string; intervalMs?: number }) => Stream.Stream<typeof StaleCheck.Type, never, never>
  readonly status: () => Effect.Effect<typeof StaleCheck.Type | undefined, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphStaleness") {}

const DAY_MS = 24 * 60 * 60 * 1000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const fs = yield* FSUtil.Service
    const lastResult = yield* Ref.make<typeof StaleCheck.Type | undefined>(undefined)

    const checkStale = (input: { root: string; thresholdMs?: number }) =>
      Effect.gen(function* () {
        const thresholdMs = input.thresholdMs ?? DAY_MS
        const files = yield* repo.listAllFiles()
        const meta = yield* repo.getMeta()

        if (files.length === 0) {
          const result: typeof StaleCheck.Type = {
            isStale: true,
            filesChanged: 0,
            filesMissing: 0,
            filesTotal: 0,
            lastChecked: Date.now(),
            reason: "no indexed files",
            graphBuiltAt: meta?.graphBuiltAt,
            graphVersion: meta?.graphVersion,
            graphCoverage: meta?.graphCoverage,
          }
          return result
        }

        let filesChanged = 0
        let filesMissing = 0
        let maxIndexedAt = 0

        for (const file of files) {
          if (file.indexedAt > maxIndexedAt) maxIndexedAt = file.indexedAt
          const statResult = yield* fs.stat(file.path).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (statResult === undefined) {
            filesMissing++
            continue
          }
          const mtimeMs = Option.getOrElse(statResult.mtime, () => new Date(0)).getTime()
          if (mtimeMs > file.indexedAt) {
            filesChanged++
          }
        }

        const now = Date.now()
        const ageMs = maxIndexedAt > 0 ? now - maxIndexedAt : Infinity
        const isGraphStale = ageMs > thresholdMs

        const reasons: string[] = []
        if (filesChanged > 0) reasons.push(`${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`)
        if (filesMissing > 0) reasons.push(`${filesMissing} file${filesMissing !== 1 ? "s" : ""} missing`)
        if (isGraphStale) {
          const days = Math.floor(ageMs / DAY_MS)
          if (days > 0) reasons.push(`graph is ${days} day${days !== 1 ? "s" : ""} old`)
          else reasons.push(`graph is ${Math.floor(ageMs / (60 * 60 * 1000))} hours old`)
        }

        const result: typeof StaleCheck.Type = {
          isStale: filesChanged > 0 || filesMissing > 0 || isGraphStale,
          filesChanged,
          filesMissing,
          filesTotal: files.length,
          lastChecked: now,
          reason: reasons.length > 0 ? reasons.join("; ") : undefined,
          graphBuiltAt: meta?.graphBuiltAt,
          graphVersion: meta?.graphVersion,
          graphCoverage: meta?.graphCoverage,
        }
        return result
      })

    const isStale: Interface["isStale"] = (input) =>
      Effect.gen(function* () {
        const result = yield* checkStale(input)
        yield* Ref.set(lastResult, result)
        return result
      })

    const status: Interface["status"] = () => Ref.get(lastResult)

    const watch: Interface["watch"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const intervalMs = input.intervalMs ?? 5 * 60 * 1000
          const q = yield* Queue.bounded<typeof StaleCheck.Type>(10).pipe(Effect.orDie)
          const tick = () =>
            Effect.gen(function* () {
              const result = yield* checkStale({ root: input.root })
              yield* Queue.offer(q, result).pipe(Effect.orDie)
            })
          yield* Effect.forkScoped(
            Effect.forever(tick()).pipe(
              Effect.schedule(Schedule.spaced(Duration.millis(intervalMs))),
            ),
          )
          return Stream.fromQueue(q)
        }),
      )

    return Service.of({ isStale, watch, status })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphRepo.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
)
