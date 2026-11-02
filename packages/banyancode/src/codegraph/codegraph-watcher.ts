export * as CodegraphWatcher from "./codegraph-watcher"

import { Effect, Queue, Scope, Stream } from "effect"
import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import { readdir } from "node:fs/promises"
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
 * Windows and macOS have a real recursive watch. On Linux it means one inotify
 * watch per directory, node_modules included: 18,000 on this repository, more
 * than the default limit on many systems, and seconds of blocking at startup.
 * So on Linux the tree is walked in the background, skipping the folders that
 * are never project edits, and each remaining directory is watched on its own.
 * If watches run out the graph keeps working: the host event subscription and
 * the periodic reconciliation still feed it.
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
const PREFILTER_SEGMENTS = [
  "node_modules",
  ".git",
  ".banyancode",
  ".opencode",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
]
const MAX_LINUX_WATCHES = 4096

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
    const watchers = new Map<string, FSWatcher>()
    let closed = false

    const offer = (absolute: string, eventType: string) => {
      if (shouldSkip(absolute, root)) return false
      const event: FileChange["event"] = eventType === "change" ? "change" : existsSync(absolute) ? "add" : "unlink"
      Queue.offerUnsafe(queue, { file: absolute, event })
      return true
    }

    const watchRecursive = () => {
      const watcher = watch(root, { recursive: true }, (eventType, filename) => {
        if (filename) offer(path.resolve(root, filename.toString()), eventType)
      })
      watcher.on("error", () => {
        enabledRef.current = false
        watcher.close()
      })
      watchers.set(root, watcher)
      enabledRef.current = true
    }

    // Walks one directory and its children, adding a watch to each. Awaiting readdir keeps the event loop free.
    const watchLinuxTree = async (directory: string): Promise<void> => {
      if (closed || watchers.has(directory)) return
      if (watchers.size >= MAX_LINUX_WATCHES) return
      try {
        const watcher = watch(directory, (eventType, filename) => {
          if (!filename) return
          const absolute = path.join(directory, filename.toString())
          if (!offer(absolute, eventType) || eventType !== "rename") return
          try {
            if (statSync(absolute).isDirectory()) void watchLinuxTree(absolute)
          } catch {
            // Removed already: the unlink above covers it.
          }
        })
        watcher.on("error", () => {
          watcher.close()
          watchers.delete(directory)
        })
        watchers.set(directory, watcher)
        enabledRef.current = true
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !PREFILTER_SEGMENTS.includes(entry.name)) {
            await watchLinuxTree(path.join(directory, entry.name))
          }
        }
      } catch {
        // Out of watches, or the directory went away. Whatever is already watched keeps working.
      }
    }

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        try {
          if (process.platform === "linux") void watchLinuxTree(root)
          else watchRecursive()
        } catch {
          enabledRef.current = false
        }
      }),
      () =>
        Effect.sync(() => {
          closed = true
          for (const watcher of watchers.values()) watcher.close()
          watchers.clear()
        }),
    )
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.ignore))

    return { watching: () => Effect.sync(() => enabledRef.current) }
  })
