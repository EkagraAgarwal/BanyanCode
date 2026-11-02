export * as CodegraphWatcher from "./codegraph-watcher"

import { Effect, Queue, Scope, Stream } from "effect"
import { existsSync, watch, type FSWatcher } from "node:fs"
import path from "node:path"
import type { FileChange } from "./codegraph-auto-update.js"

/**
 * Project-tree watcher for the incremental graph update.
 *
 * The host's `filesystem.changed` event fires for files it watches explicitly
 * (the VCS HEAD and `fs.watch` clients) — not for ordinary edits — so the
 * codegraph workstream owns a recursive watch over the project root. Every
 * event is offered into a bounded queue and drained by one fiber into
 * `autoUpdate.onChange`, exactly the handoff pattern used for native watcher
 * callbacks elsewhere: the native callback never runs Effect code inline.
 *
 * A platform that refuses a recursive watch (older Node on Linux, ENOSPC when
 * the inotify budget is exhausted) degrades to `watching() === false`; the
 * host event subscription and the periodic reconciliation keep working.
 */
export interface Interface {
  readonly watching: () => Effect.Effect<boolean, never, never>
}

export interface Deps {
  readonly root: string
  /** Feed one project-tree change into auto-update. */
  readonly onChange: (change: FileChange) => Effect.Effect<void>
}

const QUEUE_CAPACITY = 1024

// Directory names whose contents are never project edits. The indexer applies
// the full ignore matcher; this prefilter only keeps a node_modules storm from
// filling the queue.
const PREFILTER_SEGMENTS = ["node_modules", ".git", ".banyancode"]

const shouldSkip = (absolute: string, root: string): boolean => {
  const relative = path.relative(root, absolute)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) return true
  const segments = relative.split(path.sep)
  return segments.some((segment) => PREFILTER_SEGMENTS.includes(segment))
}

export const make = (deps: Deps): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const enabledRef = yield* Effect.sync(() => ({ current: false }))
    const queue = yield* Queue.bounded<FileChange>(QUEUE_CAPACITY).pipe(Effect.orDie)

    // Single drain owner for the queue (per AGENTS.md: one consumer per queue).
    yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((change) => deps.onChange(change)),
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    )

    const root = path.resolve(deps.root)
    const handle = yield* Effect.acquireRelease(
      Effect.sync((): { watcher: FSWatcher | undefined } => {
        try {
          const watcher = watch(root, { recursive: true }, (eventType, filename) => {
            if (!filename) return
            const absolute = path.resolve(root, filename.toString())
            if (shouldSkip(absolute, root)) return
            const event: FileChange["event"] = eventType === "change" ? "change" : existsSync(absolute) ? "add" : "unlink"
            Queue.offerUnsafe(queue, { file: absolute, event })
          })
          watcher.on("error", () => {
            enabledRef.current = false
            watcher.close()
          })
          enabledRef.current = true
          return { watcher }
        } catch {
          // Recursive watching is not available here; other change sources
          // (host events, reconciliation) still feed auto-update.
          enabledRef.current = false
          return { watcher: undefined }
        }
      }),
      (opened) => Effect.sync(() => opened.watcher?.close()),
    )
    if (handle.watcher === undefined) {
      yield* Effect.logWarning("codegraph auto-update: recursive file watch unavailable; relying on host events")
    }
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.ignore))

    return { watching: () => Effect.sync(() => enabledRef.current) }
  })
