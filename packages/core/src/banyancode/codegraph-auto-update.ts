export * as CodegraphAutoUpdate from "./codegraph-auto-update"

import { Cause, Context, Duration, Effect, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import fs from "node:fs"
import os from "os"
import path from "path"
import { EventV2 } from "../event"
import { Watcher } from "../filesystem/watcher"
import { BanyanConfigService } from "./banyan-config"
import { CodegraphBuildService } from "./codegraph-build-service"
import { CodegraphIndexer } from "./codegraph-indexer"
import { CodegraphRepo } from "./codegraph-repo"

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

export const ProgressState = Schema.Struct({
  status: Schema.Literals(["idle", "watching", "draining", "paused"]),
  pending: Schema.Number,
  lastChangeAt: Schema.optional(Schema.Number),
  phase: Schema.optional(Schema.Literals(["preparing", "indexing", "removing", "done"])),
  completed: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  currentFile: Schema.optional(Schema.String),
})

export type ProgressState = typeof ProgressState.Type

export const ProgressEvent = EventV2.define({
  type: "banyancode.codegraph.auto-update.progress",
  schema: ProgressState.fields,
})

export interface Interface {
  readonly state: () => Effect.Effect<State, never, never>
  readonly events: () => Queue.Dequeue<{ type: "banyancode.codegraph.auto-update"; properties: State }>
  readonly progressEvents: () => Queue.Dequeue<{
    type: "banyancode.codegraph.auto-update.progress"
    properties: ProgressState
  }>
  readonly pause: () => Effect.Effect<void, never, never>
  readonly resume: () => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphAutoUpdate") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const DEBOUNCE_MS = 500
const POLL_MS = 2000
const DELETE_GRACE_MS = 200
const MAX_BATCH_PATHS = 200

type PendingChange = "add" | "change" | "unlink"
type PendingEntry = readonly [string, PendingChange]
type ProgressExtras = Pick<ProgressState, "phase" | "completed" | "total" | "currentFile">

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
      const progressEvents = yield* Queue.dropping<{
        type: "banyancode.codegraph.auto-update.progress"
        properties: ProgressState
      }>(64).pipe(Effect.orDie)
      yield* Effect.addFinalizer(() => Effect.all([Queue.shutdown(events), Queue.shutdown(progressEvents)], { discard: true }))
      return Service.of({
        state: () => Ref.get(stateRef),
        events: () => events,
        progressEvents: () => progressEvents,
        pause: () => Effect.void,
        resume: () => Effect.void,
      })
    }

    const indexer = yield* CodegraphIndexer.Service
    const repo = yield* CodegraphRepo.Service
    const buildService = yield* CodegraphBuildService.Service
    const configOpt = yield* Effect.serviceOption(BanyanConfigService.Service)

    const enabledRef = yield* Ref.make(true)
    const debounceRef = yield* Ref.make(DEBOUNCE_MS)
    const excludePatternsRef = yield* Ref.make<readonly string[]>([])

    const refreshConfig = Effect.fn("CodegraphAutoUpdate.refreshConfig")(function* () {
      if (Option.isNone(configOpt)) return
      const cfg = yield* configOpt.value.get()
      yield* Ref.set(enabledRef, cfg.banyancode_codegraph_watch_enabled ?? true)
      const debounce = cfg.banyancode_codegraph_watch_debounce_ms ?? DEBOUNCE_MS
      yield* Ref.set(debounceRef, Math.max(100, Math.min(5000, debounce)))
      yield* Ref.set(excludePatternsRef, cfg.banyancode_codegraph_exclude_patterns ?? [])
    })
    yield* refreshConfig()

    const stateRef = yield* Ref.make<State>({ status: "idle", pending: 0 })
    const pausedRef = yield* Ref.make(false)
    const wakeQueue = yield* Queue.dropping<void>(1).pipe(Effect.orDie)
    const pendingRef = yield* Ref.make<Map<string, PendingChange>>(new Map())
    const graceSeenRef = yield* Ref.make<Set<string>>(new Set())
    const eventsQueue = yield* Queue.dropping<{ type: "banyancode.codegraph.auto-update"; properties: State }>(64).pipe(
      Effect.orDie,
    )
    const progressEventsQueue = yield* Queue.dropping<{
      type: "banyancode.codegraph.auto-update.progress"
      properties: ProgressState
    }>(64).pipe(Effect.orDie)
    const drainFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(drainFiberRef)
        if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        yield* Queue.shutdown(wakeQueue)
        yield* Queue.shutdown(eventsQueue)
        yield* Queue.shutdown(progressEventsQueue)
      }),
    )

    const publish = Effect.fn("CodegraphAutoUpdate.publish")(function* (s: State) {
      yield* Ref.set(stateRef, s)
      yield* Queue.offer(eventsQueue, { type: "banyancode.codegraph.auto-update" as const, properties: s }).pipe(Effect.ignore)
    })

    const recomputeStatus = Effect.fn("CodegraphAutoUpdate.recomputeStatus")(function* () {
      const paused = yield* Ref.get(pausedRef)
      if (paused) return yield* publish({ status: "paused", pending: 0 })
      const pending = (yield* Ref.get(pendingRef)).size
      yield* publish({
        status: pending > 0 ? "draining" : "watching",
        pending,
        lastChangeAt: Date.now(),
      })
    })

    const publishProgress = Effect.fn("CodegraphAutoUpdate.publishProgress")(function* (extras: ProgressExtras) {
      const state = yield* Ref.get(stateRef)
      const progress: ProgressState = {
        status: state.status,
        pending: state.pending,
        ...(state.lastChangeAt !== undefined ? { lastChangeAt: state.lastChangeAt } : {}),
        ...(extras.phase !== undefined ? { phase: extras.phase } : {}),
        ...(extras.completed !== undefined ? { completed: extras.completed } : {}),
        ...(extras.total !== undefined ? { total: extras.total } : {}),
        ...(extras.currentFile !== undefined ? { currentFile: extras.currentFile } : {}),
      }
      yield* Queue.offer(progressEventsQueue, {
        type: "banyancode.codegraph.auto-update.progress" as const,
        properties: progress,
      }).pipe(Effect.ignore)
    })

    // Phase 8 follow-up (auto-build false triggers): derive the workspace root
    // from the changed paths by walking UP for a workspace marker (`.banyancode`)
    // instead of returning the common parent of the changed files. The old
    // common-parent behavior made the first edit under `packages/opencode/`
    // produce `indexedRoot = <root>/packages/opencode`, and every subsequent
    // workspace-root tool call then saw a root change and forced a full rebuild
    // on each call.
    //
    // The walk is deliberately bounded: only `.banyancode` counts as a marker
    // (a `.git` boundary inside a vendored/nested subrepo would wrongly stop the
    // walk at the subrepo root), and the walk never climbs into the user's home
    // directory (the home dir commonly carries `.banyancode` / `.git`, which
    // would otherwise hijack the derived root for temp-dir fixtures and
    // deep-tree edits). The common-parent fallback handles marker-less trees.
    const WORKSPACE_ROOT_MARKERS = [".banyancode"]
    const homeDir = os.homedir()
    const normHome = process.platform === "win32" ? homeDir.toLowerCase() : homeDir

    const deriveRootFromPending = (paths: string[]): string | undefined => {
      if (paths.length === 0) return undefined

      const first = path.resolve(path.dirname(paths[0]))
      let dir = first
      while (true) {
        const norm = process.platform === "win32" ? dir.toLowerCase() : dir
        if (norm === normHome) break
        for (const marker of WORKSPACE_ROOT_MARKERS) {
          try {
            if (fs.existsSync(path.join(dir, marker))) return dir
          } catch {
            // unreachable marker — keep walking
          }
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }

      // Fall back to the common parent of all changed paths.
      const separator = os.platform() === "win32" ? path.win32.sep : path.posix.sep
      let candidate = first
      for (const filePath of paths.slice(1)) {
        const target = path.resolve(path.dirname(filePath))
        while (candidate !== target && !target.startsWith(candidate + separator)) {
          const parent = path.dirname(candidate)
          if (parent === candidate) break
          candidate = parent
        }
      }
      return candidate
    }

    const initialBuildTriggeredRef = yield* Ref.make(false)

    const processBatch = Effect.fn("CodegraphAutoUpdate.processBatch")(function* () {
      const collected = yield* Ref.getAndUpdate(pendingRef, () => new Map())
      if (collected.size === 0) return

      const entries = [...collected.entries()]
      const batchEntries = entries.slice(0, MAX_BATCH_PATHS)
      const overflowEntries = entries.slice(MAX_BATCH_PATHS)
      const batch = new Map<string, PendingChange>(batchEntries)

      // Give atomic-save rename sequences a short window to deliver their add/change.
      for (const [filePath, change] of batchEntries) {
        if (change !== "unlink") continue
        const seen = yield* Ref.getAndUpdate(graceSeenRef, (paths) => {
          if (paths.has(filePath)) return paths
          const next = new Set(paths)
          next.add(filePath)
          return next
        })
        if (seen.has(filePath)) continue
        yield* Effect.sleep(Duration.millis(DELETE_GRACE_MS))
        const latest = yield* Ref.getAndUpdate(pendingRef, (pending) => {
          const next = new Map(pending)
          next.delete(filePath)
          return next
        })
        if (latest.get(filePath) === "add" || latest.get(filePath) === "change") batch.set(filePath, "change")
      }

      yield* publish({
        status: "draining",
        pending: batch.size + (yield* Ref.get(pendingRef)).size,
        lastChangeAt: Date.now(),
      })

      const requeue = Effect.fn("CodegraphAutoUpdate.requeue")(function* (items: readonly PendingEntry[]) {
        if (items.length === 0) return
        yield* Ref.update(pendingRef, (pending) => {
          const next = new Map(pending)
          for (const [filePath, change] of items) {
            if (!next.has(filePath)) next.set(filePath, change)
          }
          return next
        })
        yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
      })

      const buildState = yield* buildService.status()
      if (buildState.status === "running") {
        yield* Effect.logDebug("codegraph auto-update: deferring until build completes")
        yield* requeue(batchEntries)
        yield* requeue(overflowEntries)
        yield* Effect.sleep(Duration.millis(POLL_MS))
        return
      }

      const meta = yield* repo.getMeta()
      if (!meta || !meta.indexedRoot) {
        const derived = deriveRootFromPending([...batch.keys()])
        if (derived) {
          const alreadyTriggered = yield* Ref.get(initialBuildTriggeredRef)
          if (!alreadyTriggered) {
            yield* Ref.set(initialBuildTriggeredRef, true)
            yield* Effect.logInfo(`codegraph auto-update: no indexedRoot, triggering initial build for ${derived}`)
            const excludePatterns = yield* Ref.get(excludePatternsRef)
            yield* buildService.start({ root: derived, force: false, excludePatterns }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("codegraph auto-update: initial build failed", { cause: Cause.pretty(cause) }),
              ),
            )
          }
        } else {
          yield* Effect.logWarning("codegraph auto-update: could not derive root from pending paths, skipping")
        }
        yield* requeue(overflowEntries)
        return
      }

      const root = meta.indexedRoot
      const removals = [...batch].filter(([, change]) => change === "unlink").map(([filePath]) => filePath)
      const additions = [...batch].filter(([, change]) => change !== "unlink").map(([filePath, change]) => [filePath, change] as const)
      const excludePatterns = yield* Ref.get(excludePatternsRef)

      if (removals.length > 0) {
        yield* publishProgress({ phase: "preparing", total: removals.length })
        yield* publishProgress({ phase: "removing", completed: 0, total: removals.length, currentFile: removals[0] })
        yield* indexer.removeFiles({ root, paths: removals }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codegraph auto-update: removeFiles failed", { cause: Cause.pretty(cause) }),
          ),
        )
        yield* publishProgress({ phase: "removing", completed: removals.length, total: removals.length, currentFile: removals[removals.length - 1] })
        yield* publishProgress({ phase: "done", completed: removals.length, total: removals.length })
      }

      if (additions.length > 0) {
        const paths = additions.map(([filePath]) => filePath)
        yield* publishProgress({ phase: "preparing", total: paths.length })
        const result = yield* indexer.indexFiles({
          root,
          paths,
          excludePatterns,
          onProgress: Effect.fn("CodegraphAutoUpdate.indexProgress")(function* ({ file, done, total, currentFile }) {
            yield* publishProgress({ phase: "indexing", completed: done, total, currentFile: currentFile ?? file })
          }),
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("codegraph auto-update: indexFiles failed", { cause: Cause.pretty(cause) })
              return { indexed: 0, skipped: 0, parseErrors: [] }
            }),
          ),
        )
        yield* publishProgress({ phase: "indexing", completed: result.indexed, total: paths.length, currentFile: paths[paths.length - 1] })
        yield* publishProgress({ phase: "done", completed: result.indexed, total: paths.length })
        // NOTE: do NOT requeue on `result.skipped > 0`. The indexer's `skipped` count
        // is a deterministic aggregate — it includes files filtered out as ignored,
        // oversize, artifact, cached, or genuinely skipped. Requeueing any of those
        // causes the drain loop to spin forever, the state stays "draining", and the
        // header pill is stuck on "Graph: syncing (N)" with a blue dot. Transient
        // read errors are recovered by the next watcher event if the file is touched
        // again, so the watcher is the right source of truth for re-indexing.
      }

      yield* requeue(overflowEntries)
      yield* recomputeStatus()
    })

    const drainFiber = yield* Effect.forkDetach(
      Effect.gen(function* () {
        while (true) {
          yield* Queue.take(wakeQueue).pipe(Effect.catchCause(() => Effect.void))
          let quiet = false
          while (!quiet) {
            const debounce = yield* Ref.get(debounceRef)
            yield* Effect.sleep(Duration.millis(debounce))
            const signal = yield* Queue.poll(wakeQueue)
            quiet = Option.isNone(signal)
          }
          while ((yield* Ref.get(pendingRef)).size > 0) yield* processBatch()
        }
      }).pipe(Effect.catchCause((cause) => Effect.logError("codegraph auto-update drain loop failed", { cause: Cause.pretty(cause) }))),
    )
    yield* Ref.set(drainFiberRef, drainFiber)

    yield* publish({ status: "idle", pending: 0 })

    const eventService = yield* EventV2.Service
    const unsubscribe = yield* eventService.listen((event) =>
      Effect.gen(function* () {
        if (event.type !== Watcher.Event.Updated.type) return
        if (yield* Ref.get(pausedRef)) return
        if (!(yield* Ref.get(enabledRef))) return
        yield* refreshConfig()

        const data = event.data as { file: string; event: PendingChange }
        const meta = yield* repo.getMeta()
        if (meta?.indexedRoot) {
          const norm = (p: string) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p)
          if (!event.location?.directory || norm(event.location.directory) !== norm(meta.indexedRoot)) return
        }

        yield* Ref.update(pendingRef, (pending) => {
          const next = new Map(pending)
          next.set(data.file, data.event)
          return next
        })
        if (data.event !== "unlink") yield* Ref.update(graceSeenRef, (seen) => {
          const next = new Set(seen)
          next.delete(data.file)
          return next
        })
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
        yield* publish({ status: "paused", pending: 0 })
      })

    const resume: Interface["resume"] = () =>
      Effect.gen(function* () {
        yield* Ref.set(pausedRef, false)
        yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
        yield* recomputeStatus()
      })

    return Service.of({
      state: () => Ref.get(stateRef),
      events: () => eventsQueue,
      progressEvents: () => progressEventsQueue,
      pause,
      resume,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphIndexer.defaultLayer),
  Layer.provide(CodegraphRepo.defaultLayer),
  Layer.provide(CodegraphBuildService.defaultLayer),
  Layer.provide(BanyanConfigService.defaultLayer),
)
