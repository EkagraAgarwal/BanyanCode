export * as CodegraphAutoUpdate from "./codegraph-auto-update"

import { Cause, Context, Duration, Effect, Fiber, Option, Queue, Ref, Schema, Scope } from "effect"
import fs from "node:fs"
import os from "os"
import path from "path"
import type { Interface as CodegraphBuildServiceInterface } from "./codegraph-build-service.js"
import type { Interface as CodegraphIndexerInterface } from "./codegraph-indexer.js"
import type { Interface as CodegraphRepoInterface } from "./codegraph-repo.js"
import { probeFileDrift } from "./graph-staleness.js"

export const State = Schema.Struct({
  status: Schema.Literals(["idle", "watching", "draining", "paused"]),
  pending: Schema.Number,
  lastChangeAt: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/CodegraphAutoUpdateState" })

export type State = typeof State.Type

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

export interface FileChange {
  readonly file: string
  readonly event: "add" | "change" | "unlink"
  /** Workspace directory the host reported for the event, when present. */
  readonly directory?: string
}

export interface ConfigReader {
  readonly getWatchOptions: () => Effect.Effect<{
    readonly enabled: boolean
    readonly debounceMs: number
    readonly excludePatterns: readonly string[]
  }>
}

export interface Interface {
  readonly state: () => Effect.Effect<State, never, never>
  readonly events: () => Queue.Dequeue<State>
  readonly progressEvents: () => Queue.Dequeue<ProgressState>
  /**
   * Feed one host `filesystem.changed` event. `register()` is the single
   * subscriber of that stream; the service never subscribes on its own.
   */
  readonly onChange: (change: FileChange) => Effect.Effect<void>
  // Bounded flush: drain up to maxPaths pending paths for root (or all
  // pending when root is omitted) via indexFiles/removeFiles. Never starts
  // a full build; returns per-root discovered/indexed/removed/cached counts.
  readonly flush: (input?: {
    readonly root?: string
    readonly maxPaths?: number
  }) => Effect.Effect<
    { discovered: number; indexed: number; removed: number; cached: number; pending: number },
    never,
    never
  >
  // Periodic reconciliation: probe indexed rows for size+mtime drift and
  // deleted files, enqueue the drifted paths, and wake the drain. New files
  // on disk are picked up by the watcher; this covers edits/deletes the
  // watcher missed while paused or offline.
  readonly reconcile: (input?: {
    readonly root?: string
  }) => Effect.Effect<{ discovered: number; changed: number; removed: number; cached: number }, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphAutoUpdate") {}

export const DEBOUNCE_MS = 500
const POLL_MS = 2000
const DELETE_GRACE_MS = 200
const MAX_BATCH_PATHS = 200

type PendingChange = "add" | "change" | "unlink"
type PendingEntry = readonly [string, PendingChange]
type ProgressExtras = Pick<ProgressState, "phase" | "completed" | "total" | "currentFile">

export interface Deps {
  readonly indexer: CodegraphIndexerInterface
  readonly repo: CodegraphRepoInterface
  readonly buildService: CodegraphBuildServiceInterface
  readonly config: ConfigReader
  /** Project directory — used to ignore the plugin's own data directory. */
  readonly projectDirectory: string
  /** Absolute path of the plugin database; changes to it are never project edits. */
  readonly dbPath: string
}

export const make = (deps: Deps): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const indexer = deps.indexer
    const repo = deps.repo
    const buildService = deps.buildService

    const enabledRef = yield* Ref.make(true)
    const debounceRef = yield* Ref.make(DEBOUNCE_MS)
    const excludePatternsRef = yield* Ref.make<readonly string[]>([])

    const refreshConfig = Effect.fn("CodegraphAutoUpdate.refreshConfig")(function* () {
      const cfg = yield* deps.config.getWatchOptions().pipe(
        Effect.orElseSucceed(() => ({
          enabled: true,
          debounceMs: DEBOUNCE_MS,
          excludePatterns: [] as readonly string[],
        })),
      )
      yield* Ref.set(enabledRef, cfg.enabled)
      yield* Ref.set(debounceRef, Math.max(100, Math.min(5000, cfg.debounceMs)))
      yield* Ref.set(excludePatternsRef, cfg.excludePatterns)
    })
    yield* refreshConfig()

    const stateRef = yield* Ref.make<State>({ status: "idle", pending: 0 })
    const pausedRef = yield* Ref.make(false)
    const wakeQueue = yield* Queue.dropping<void>(1).pipe(Effect.orDie)
    const pendingRef = yield* Ref.make<Map<string, PendingChange>>(new Map())
    const graceSeenRef = yield* Ref.make<Set<string>>(new Set())
    const eventsQueue = yield* Queue.dropping<State>(64).pipe(Effect.orDie)
    const progressEventsQueue = yield* Queue.dropping<ProgressState>(64).pipe(Effect.orDie)
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
      yield* Queue.offer(eventsQueue, s).pipe(Effect.ignore)
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
      yield* Queue.offer(progressEventsQueue, progress).pipe(Effect.ignore)
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
    const normPath = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p))
    // The plugin's own data lives in `<project>/.banyancode/`, including the
    // SQLite database and its WAL/SHM sidecars. Those writes are never project
    // edits and must not trigger a re-index loop.
    const ownDb = normPath(deps.dbPath)
    const ownDataDir = normPath(path.join(deps.projectDirectory, ".banyancode"))
    const isOwnPath = (file: string) => {
      const target = normPath(file)
      return (
        target === ownDb ||
        target.startsWith(ownDb + "-") ||
        target === ownDataDir ||
        target.startsWith(ownDataDir + path.sep)
      )
    }

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
            if (fs.existsSync(path.join(dir, marker))) {
              // A marker at the filesystem root (e.g. `D:\.banyancode`) is
              // polluted state, not a workspace marker — deriving the root as
              // the whole drive would make the initial build index the entire
              // disk. Fall through to the common-parent fallback instead.
              if (path.parse(dir).root !== dir) return dir
            }
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
      // The common parent can also collapse to a filesystem root (e.g. a
      // single changed file directly under `D:\`) — never derive the root as
      // the whole drive; let the caller log "could not derive root" instead.
      return path.parse(candidate).root === candidate ? undefined : candidate
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
            yield* buildService
              .start({ root: derived, force: false, excludePatterns })
              .pipe(
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
      const additions = [...batch]
        .filter(([, change]) => change !== "unlink")
        .map(([filePath, change]) => [filePath, change] as const)
      const excludePatterns = yield* Ref.get(excludePatternsRef)

      if (removals.length > 0) {
        yield* publishProgress({ phase: "preparing", total: removals.length })
        yield* publishProgress({ phase: "removing", completed: 0, total: removals.length, currentFile: removals[0] })
        yield* indexer
          .removeFiles({ root, paths: removals })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("codegraph auto-update: removeFiles failed", { cause: Cause.pretty(cause) }),
            ),
          )
        // Unlink-only paths never reach the add/change cleanup in the listener
        // (:389-393), so drop them here or graceSeenRef grows without bound on
        // long-lived watchers. A later unlink for the same path gets a fresh
        // grace window, which is the desired behavior.
        yield* Ref.update(graceSeenRef, (seen) => {
          const next = new Set(seen)
          for (const filePath of removals) next.delete(filePath)
          return next
        })
        yield* publishProgress({
          phase: "removing",
          completed: removals.length,
          total: removals.length,
          currentFile: removals[removals.length - 1],
        })
        yield* publishProgress({ phase: "done", completed: removals.length, total: removals.length })
      }

      if (additions.length > 0) {
        const paths = additions.map(([filePath]) => filePath)
        yield* publishProgress({ phase: "preparing", total: paths.length })
        const result = yield* indexer
          .indexFiles({
            root,
            paths,
            excludePatterns,
            onProgress: Effect.fn("CodegraphAutoUpdate.indexProgress")(function* ({ file, done, total, currentFile }) {
              yield* publishProgress({ phase: "indexing", completed: done, total, currentFile: currentFile ?? file })
            }),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("codegraph auto-update: indexFiles failed", { cause: Cause.pretty(cause) })
                return { indexed: 0, skipped: 0, parseErrors: [] }
              }),
            ),
          )
        yield* publishProgress({
          phase: "indexing",
          completed: result.indexed,
          total: paths.length,
          currentFile: paths[paths.length - 1],
        })
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
          while ((yield* Ref.get(pendingRef)).size > 0) {
            // A single processBatch failure must not kill the drain forever —
            // pendingRef is drained at the top of processBatch, so on failure
            // the loop exits back to Queue.take and stays alive for the next
            // wake. Log and continue.
            yield* processBatch().pipe(
              Effect.catchCause((cause) =>
                Effect.logError("codegraph auto-update: processBatch failed", { cause: Cause.pretty(cause) }),
              ),
            )
          }
        }
      }),
    )
    yield* Ref.set(drainFiberRef, drainFiber)

    yield* publish({ status: "idle", pending: 0 })

    const onChange: Interface["onChange"] = (change) =>
      Effect.gen(function* () {
        if (yield* Ref.get(pausedRef)) return
        if (!(yield* Ref.get(enabledRef))) return
        yield* refreshConfig()
        // BanyanCode's own data/state/cache writes are never project files.
        if (isOwnPath(change.file)) return
        const meta = yield* repo.getMeta()
        if (meta?.indexedRoot) {
          if (!change.directory || normPath(change.directory) !== normPath(meta.indexedRoot)) return
        }
        yield* Ref.update(pendingRef, (pending) => {
          const next = new Map(pending)
          next.set(change.file, change.event)
          return next
        })
        if (change.event !== "unlink") {
          yield* Ref.update(graceSeenRef, (seen) => {
            const next = new Set(seen)
            next.delete(change.file)
            return next
          })
        }
        yield* recomputeStatus()
        yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("codegraph auto-update: onChange failed", { cause: Cause.pretty(cause) }),
        ),
      )


    return {
      state: () => Ref.get(stateRef),
      events: () => eventsQueue,
      progressEvents: () => progressEventsQueue,
      onChange,
      flush: (input = {}) =>
        Effect.gen(function* () {
          const meta = yield* repo.getMeta().pipe(Effect.orElseSucceed(() => undefined))
          const root = input.root ?? meta?.indexedRoot
          if (!root)
            return { discovered: 0, indexed: 0, removed: 0, cached: 0, pending: (yield* Ref.get(pendingRef)).size }
          const maxPaths = Math.max(1, Math.min(MAX_BATCH_PATHS, input.maxPaths ?? MAX_BATCH_PATHS))
          const snapshot = yield* Ref.getAndUpdate(pendingRef, (pending) => {
            const next = new Map(pending)
            let taken = 0
            for (const key of next.keys()) {
              if (taken >= maxPaths) break
              if (key === root || key.startsWith(root + path.sep)) {
                next.delete(key)
                taken++
              }
            }
            return next
          })
          const batch = [...snapshot.entries()]
            .filter(([filePath]) => filePath === root || filePath.startsWith(root + path.sep))
            .slice(0, maxPaths)
          if (batch.length === 0) {
            return { discovered: 0, indexed: 0, removed: 0, cached: 0, pending: (yield* Ref.get(pendingRef)).size }
          }
          const removals = batch.filter(([, change]) => change === "unlink").map(([filePath]) => filePath)
          const additions = batch.filter(([, change]) => change !== "unlink").map(([filePath]) => filePath)
          const excludePatterns = yield* Ref.get(excludePatternsRef)
          let indexed = 0
          let cached = 0
          if (removals.length > 0) {
            yield* indexer.removeFiles({ root, paths: removals }).pipe(Effect.ignore)
          }
          if (additions.length > 0) {
            const result = yield* indexer
              .indexFiles({ root, paths: additions, excludePatterns })
              .pipe(Effect.orElseSucceed(() => ({ indexed: 0, skipped: additions.length, parseErrors: [] })))
            indexed = result.indexed
            cached = result.skipped
          }
          yield* recomputeStatus()
          return {
            discovered: 0,
            indexed,
            removed: removals.length,
            cached,
            pending: (yield* Ref.get(pendingRef)).size,
          }
        }),
      reconcile: (input = {}) =>
        Effect.gen(function* () {
          const meta = yield* repo.getMeta().pipe(Effect.orElseSucceed(() => undefined))
          const root = input.root ?? meta?.indexedRoot
          if (!root) return { discovered: 0, changed: 0, removed: 0, cached: 0 }
          const probe = yield* probeFileDrift(repo)
          const inScope = (filePath: string) => filePath === root || filePath.startsWith(root + path.sep)
          const changed = probe.changedPaths.filter(inScope)
          const removed = probe.removedPaths.filter(inScope)
          if (changed.length > 0 || removed.length > 0) {
            yield* Ref.update(pendingRef, (pending) => {
              const next = new Map(pending)
              for (const filePath of changed) next.set(filePath, "change")
              for (const filePath of removed) next.set(filePath, "unlink")
              return next
            })
            yield* Queue.offer(wakeQueue, undefined).pipe(Effect.ignore)
          }
          return { discovered: 0, changed: changed.length, removed: removed.length, cached: probe.cached }
        }),
    }
  })
