export * as CodegraphAutoUpdate from "./codegraph-auto-update"

import { Cause, Context, Duration, Effect, Layer, Option, Queue, Ref, Schema } from "effect"
import { EventV2 } from "../event"
import { Watcher } from "../filesystem/watcher"
import { BanyanConfigService } from "./banyan-config"
import { CodegraphBuildService } from "./codegraph-build-service"
import { CodegraphIndexer } from "./codegraph-indexer"
import { CodegraphRepo } from "./codegraph-repo"

// Public event shape published by this service. Consumers (e.g. a future TUI
// badge) subscribe via the codegraph auto-update bridge, identical to how
// CodegraphBuildService events are drained. Keeping this minimal for v1 — no
// detailed per-file state, just a coarse busy/pending summary.
export const State = Schema.Struct({
  status: Schema.Literals(["idle", "watching", "draining", "paused"]),
  pending: Schema.Number,
  lastChangeAt: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/CodegraphAutoUpdateState" })

export type State = typeof State.Type

export const Event = EventV2.define({
  type: "banyancode.codegraph.auto-update",
  schema: State.fields,
})

export interface Interface {
  readonly state: () => Effect.Effect<State, never, never>
  readonly events: () => Queue.Dequeue<{ type: "banyancode.codegraph.auto-update"; properties: State }>
  readonly pause: () => Effect.Effect<void, never, never>
  readonly resume: () => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphAutoUpdate") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const DEBOUNCE_MS = 500
const POLL_MS = 2000
const MAX_BATCH_PATHS = 200

export const layer: Layer.Layer<
  Service,
  never,
  EventV2.Service | CodegraphIndexer.Service | CodegraphRepo.Service | CodegraphBuildService.Service | BanyanConfigService.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const stateRef = yield* Ref.make<State>({ status: "idle", pending: 0 })
      const events = yield* Queue.dropping<{ type: "banyancode.codegraph.auto-update"; properties: State }>(64).pipe(
        Effect.orDie,
      )
      yield* Effect.addFinalizer(() => Queue.shutdown(events))
      return Service.of({
        state: () => Ref.get(stateRef),
        events: () => events,
        pause: () => Effect.void,
        resume: () => Effect.void,
      })
    }

    const indexer = yield* CodegraphIndexer.Service
    const repo = yield* CodegraphRepo.Service
    const buildService = yield* CodegraphBuildService.Service
    const configOpt = yield* Effect.serviceOption(BanyanConfigService.Service)

    const configDebounce = (): number => {
      if (Option.isNone(configOpt)) return DEBOUNCE_MS
      const svc = configOpt.value
      const v = svc as unknown as { get: () => Promise<{ banyancode_codegraph_watch_debounce_ms?: number }> }
      // Synchronous best-effort read; BanyanConfigService.get returns a Promise
      // but for debounce we just use the default. Real async config reads happen
      // lazily before each batch.
      return DEBOUNCE_MS
    }

    const enabledRef = yield* Ref.make(true)
    const debounceRef = yield* Ref.make(DEBOUNCE_MS)

    const refreshConfig = Effect.fn("CodegraphAutoUpdate.refreshConfig")(function* () {
      if (Option.isNone(configOpt)) return
      const cfg = yield* configOpt.value.get()
      yield* Ref.set(enabledRef, cfg.banyancode_codegraph_watch_enabled ?? true)
      const debounce = cfg.banyancode_codegraph_watch_debounce_ms ?? DEBOUNCE_MS
      const clamped = Math.max(100, Math.min(5000, debounce))
      yield* Ref.set(debounceRef, clamped)
    })
    yield* refreshConfig()

    const stateRef = yield* Ref.make<State>({ status: "idle" as const, pending: 0 })
    const pausedRef = yield* Ref.make(false)
    const wakeQueue = yield* Queue.dropping<void>(1).pipe(Effect.orDie)
    const pendingAddRef = yield* Ref.make<Map<string, true>>(new Map())
    const pendingRemoveRef = yield* Ref.make<Set<string>>(new Set())
    const eventsQueue = yield* Queue.dropping<{ type: "banyancode.codegraph.auto-update"; properties: State }>(64).pipe(
      Effect.orDie,
    )
    yield* Effect.addFinalizer(() => Queue.shutdown(eventsQueue))

    const publish = (s: State): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        yield* Ref.set(stateRef, s)
        yield* Queue.offer(eventsQueue, { type: "banyancode.codegraph.auto-update" as const, properties: s }).pipe(
          Effect.ignore,
        )
      })

    const snapshot = (overrides: Partial<State> = {}): State => {
      return {
        status: overrides.status ?? "watching",
        pending: overrides.pending ?? 0,
        ...(overrides.lastChangeAt !== undefined ? { lastChangeAt: overrides.lastChangeAt } : {}),
      }
    }

    const recomputeStatus = Effect.fn("CodegraphAutoUpdate.recomputeStatus")(function* () {
      const paused = yield* Ref.get(pausedRef)
      if (paused) return yield* publish({ status: "paused", pending: 0 })
      const adds = yield* Ref.get(pendingAddRef)
      const removes = yield* Ref.get(pendingRemoveRef)
      const total = adds.size + removes.size
      const next: State = {
        status: total > 0 ? "draining" : "watching",
        pending: total,
        lastChangeAt: Date.now(),
      }
      yield* publish(next)
    })

    // Helper: derive the longest common prefix path from a list of file paths.
    // Simple approach: start with the first path, walk up with dirname until all paths share the prefix.
    const deriveRootFromPending = (paths: string[]): string | undefined => {
      if (paths.length === 0) return undefined
      let candidate = paths[0]
      const isPrefix = (p: string) => candidate === p || p.startsWith(candidate + "/") || candidate.startsWith(p + "/")
      while (candidate && !paths.every(isPrefix)) {
        candidate = candidate.split("/").slice(0, -1).join("/")
      }
      return candidate || undefined
    }

    const initialBuildTriggeredRef = yield* Ref.make(false)

    // Re-read graph metadata lazily before each batch so a fresh full build
    // that changed indexed_root steers subsequent events to the new root.
    const processBatch = Effect.fn("CodegraphAutoUpdate.processBatch")(function* () {
      const collected = yield* Effect.gen(function* () {
        const adds = yield* Ref.getAndUpdate(pendingAddRef, () => new Map())
        const removes = yield* Ref.getAndUpdate(pendingRemoveRef, () => new Set())
        return { adds, removes }
      })

      // Cap the batch to prevent OOM on a 10K-file event storm.
      let batchAdds = collected.adds
      let batchRemoves = collected.removes
      let overflowAdds: Array<string> = []
      let overflowRemoves: Array<string> = []

      const total = collected.adds.size + collected.removes.size
      if (total > MAX_BATCH_PATHS) {
        const addEntries = [...collected.adds.entries()]
        const removeArr = [...collected.removes]

        const splitAdd = Math.min(addEntries.length, MAX_BATCH_PATHS)
        batchAdds = new Map(addEntries.slice(0, splitAdd))
        overflowAdds = addEntries.slice(splitAdd).map(([k]) => k)

        const remaining = MAX_BATCH_PATHS - splitAdd
        if (remaining > 0) {
          batchRemoves = new Set(removeArr.slice(0, remaining))
          overflowRemoves = removeArr.slice(remaining)
        } else {
          batchRemoves = new Set()
          overflowRemoves = removeArr
        }
      }

      if (batchAdds.size === 0 && batchRemoves.size === 0) return

      yield* recomputeStatus()

      const buildState = yield* buildService.status()
      if (buildState.status === "running") {
        yield* Effect.logDebug("codegraph auto-update: deferring until build completes")
        yield* Effect.sleep(Duration.millis(POLL_MS))
        yield* Ref.update(pendingAddRef, (m) => {
          for (const k of batchAdds.keys()) m.set(k, true)
          return m
        })
        yield* Ref.update(pendingRemoveRef, (s) => {
          for (const k of batchRemoves) s.add(k)
          return s
        })
        yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
        return
      }

      const meta = yield* repo.getMeta()
      if (!meta || !meta.indexedRoot) {
        // Fresh workspace: derive root from pending files and trigger initial build
        const pendingPaths = [...batchAdds.keys(), ...batchRemoves]
        if (pendingPaths.length > 0) {
          const derived = deriveRootFromPending(pendingPaths)
          if (derived) {
            const alreadyTriggered = yield* Ref.get(initialBuildTriggeredRef)
            if (!alreadyTriggered) {
              yield* Ref.set(initialBuildTriggeredRef, true)
              yield* Effect.logInfo(`codegraph auto-update: no indexedRoot, triggering initial build for ${derived}`)
              yield* buildService.start({ root: derived, force: false }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("codegraph auto-update: initial build failed", { cause: Cause.pretty(cause) }),
                ),
              )
            }
          } else {
            yield* Effect.logWarning("codegraph auto-update: could not derive root from pending paths, skipping")
          }
        }
        // Re-queue overflow into the refs for the next batch.
        if (overflowAdds.length > 0 || overflowRemoves.length > 0) {
          yield* Ref.update(pendingAddRef, (m) => {
            for (const p of overflowAdds) m.set(p, true)
            return m
          })
          yield* Ref.update(pendingRemoveRef, (s) => {
            for (const p of overflowRemoves) s.add(p)
            return s
          })
          yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
        }
        return
      }
      const root = meta.indexedRoot

      if (batchRemoves.size > 0) {
        yield* indexer.removeFiles({ root, paths: [...batchRemoves] }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codegraph auto-update: removeFiles failed", { cause: Cause.pretty(cause) }),
          ),
        )
      }
      if (batchAdds.size > 0) {
        yield* indexer.indexFiles({ root, paths: [...batchAdds.keys()] }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codegraph auto-update: indexFiles failed", { cause: Cause.pretty(cause) }),
          ),
        )
      }

      // Re-queue overflow into the refs for the next batch.
      if (overflowAdds.length > 0 || overflowRemoves.length > 0) {
        yield* Ref.update(pendingAddRef, (m) => {
          for (const p of overflowAdds) m.set(p, true)
          return m
        })
        yield* Ref.update(pendingRemoveRef, (s) => {
          for (const p of overflowRemoves) s.add(p)
          return s
        })
        yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
      }

      yield* recomputeStatus()
    })

    // Drain worker: wait for next wake signal, sleep a quiet window so bursts
    // collapse, then process whatever accumulated. Loop until pending empties.
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        while (true) {
          yield* Queue.take(wakeQueue).pipe(Effect.catchCause(() => Effect.void))
          const debounce = yield* Ref.get(debounceRef)
          yield* Effect.sleep(Duration.millis(debounce))
          while (true) {
            const adds = yield* Ref.get(pendingAddRef)
            const removes = yield* Ref.get(pendingRemoveRef)
            if (adds.size === 0 && removes.size === 0) break
            yield* processBatch()
          }
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("codegraph auto-update drain loop failed", { cause: Cause.pretty(cause) }))),
    )

    // Initial state: idle until a watcher event arrives. The watcher
    // publishes Watcher.Event.Updated with `event.location.directory`; we
    // filter against the current graph's indexed_root so the same global
    // listener ignores events for unrelated workspaces.
    yield* publish(snapshot({ status: "idle", pending: 0 }))

    const events = yield* EventV2.Service
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== Watcher.Event.Updated.type) return
        if (yield* Ref.get(pausedRef)) return
        if (!(yield* Ref.get(enabledRef))) return
        yield* refreshConfig()

        const data = event.data as { file: string; event: "add" | "change" | "unlink" }
        const meta = yield* repo.getMeta()
        if (!meta || !meta.indexedRoot) return
        if (event.location?.directory !== meta.indexedRoot) return

        if (data.event === "unlink") {
          yield* Ref.update(pendingRemoveRef, (s) => {
            s.add(data.file)
            return s
          })
        } else {
          yield* Ref.update(pendingAddRef, (m) => {
            m.set(data.file, true)
            return m
          })
        }
        yield* recomputeStatus()
        yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("codegraph auto-update: listen branch failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    const pause: Interface["pause"] = () =>
      Effect.gen(function* () {
        yield* Ref.set(pausedRef, true)
        yield* publish(snapshot({ status: "paused", pending: 0 }))
      })

    const resume: Interface["resume"] = () =>
      Effect.gen(function* () {
        yield* Ref.set(pausedRef, false)
        yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
        yield* recomputeStatus()
      })

    const state: Interface["state"] = () => Ref.get(stateRef)
    const eventsDequeue: Interface["events"] = () => eventsQueue

    return Service.of({ state, events: eventsDequeue, pause, resume })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphIndexer.defaultLayer),
  Layer.provide(CodegraphRepo.defaultLayer),
  Layer.provide(CodegraphBuildService.defaultLayer),
  Layer.provide(BanyanConfigService.defaultLayer),
)
