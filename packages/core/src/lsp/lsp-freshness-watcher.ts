// Phase 4 (LSP freshness): a dedicated Parcel-based watcher instance used by
// the LspFreshnessService. Distinct from the opencode FileWatcher
// (`packages/core/src/filesystem/watcher.ts`) because the lifecycle is owned
// by the freshness service: a single `start(root)` call subscribes, the
// matching `stop()` unsubscribes, and the event queue ownership belongs to
// the freshness layer (per AGENTS.md "Effect Queue is single-consumer" rule).
//
// Pattern follows AGENTS.md "Hot-path callbacks that need Effect queue
// handoff": Parcel callbacks cannot await Effect, so each native-thread
// callback offers the batch into a bounded `Queue.bounded(N)`; a single
// `Effect.forkDetach(Stream.fromQueue(queue))` drains and feeds the freshness
// service's `EventV2` stream. Bounded capacity caps backpressure.

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { Effect, Queue } from "effect"
import path from "path"
import { lazy } from "../util/lazy"

declare const OPENCODE_LIBC: string | undefined

export const LSP_WATCHER_QUEUE_CAPACITY = 256

export type LspWatcherEvent =
  | { kind: "change"; path: string; type: "add" | "change" | "unlink" }
  | { kind: "error"; cause: unknown }

const parcelBinding = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})

const getBackend = (): ParcelWatcher.BackendType | undefined => {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
  return undefined
}

export const lspWatcherBackendAvailable = (): boolean => Boolean(parcelBinding() && getBackend())

export interface LspWatcherHandle {
  readonly stop: () => Effect.Effect<void, never, never>
}

export interface LspWatcherOptions {
  readonly ignore?: ReadonlyArray<string>
  readonly queueCapacity?: number
}

const DEFAULT_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.banyancode/**",
  "**/.opencode/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.next/**",
  "**/__pycache__/**",
]

/**
 * Subscribe to a single workspace root. Returns a handle whose `stop()`
 * shuts down the underlying Parcel subscription and the queue. The returned
 * `events` value is the underlying `Queue.Dequeue<LspWatcherEvent>` so the
 * freshness layer (the single owner) can attach its own drain fiber with
 * `Stream.fromQueue(events)`. Returning a Stream would hide the queue and
 * make it impossible to enforce single-consumer ownership.
 */
export const startLspFreshnessWatcher = (
  root: string,
  options: LspWatcherOptions = {},
): Effect.Effect<{ handle: LspWatcherHandle; events: Queue.Dequeue<LspWatcherEvent> }, never, never> =>
  Effect.gen(function* () {
    const w = parcelBinding()
    const backend = getBackend()
    if (!w || !backend) {
      // Watcher backend unavailable on this platform. Surface an empty
      // unbounded dequeue so the service still constructs; downstream
      // consumers just see nothing. The HTTP start endpoint returns ok=true
      // so the service is up but the watcher is a no-op. Mirrors the
      // OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER behavior.
      const events = yield* Queue.unbounded<LspWatcherEvent>()
      return {
        handle: { stop: () => Effect.void },
        events,
      }
    }

    const queue = yield* Queue.bounded<LspWatcherEvent>(options.queueCapacity ?? LSP_WATCHER_QUEUE_CAPACITY)
    const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])]
    const subscription: ParcelWatcher.AsyncSubscription = yield* Effect.tryPromise({
      try: () => w.subscribe(root, buildParcelCallback(queue), { ignore, backend }),
      catch: (cause) => cause,
    }).pipe(Effect.orDie)

    const handle: LspWatcherHandle = {
      stop: () =>
        Effect.gen(function* () {
          yield* Effect.promise(() => subscription.unsubscribe()).pipe(Effect.ignore)
          yield* Queue.shutdown(queue)
        }),
    }
    return { handle, events: queue }
  })

const buildParcelCallback = (queue: Queue.Queue<LspWatcherEvent>): ParcelWatcher.SubscribeCallback => (error, updates) => {
  if (error) {
    Effect.runFork(Queue.offer(queue, { kind: "error", cause: error }).pipe(Effect.ignore))
    return
  }
  Effect.runFork(
    Effect.gen(function* () {
      for (const update of updates) {
        const type: "add" | "change" | "unlink" =
          update.type === "create" ? "add" : update.type === "delete" ? "unlink" : "change"
        const relPath = path.isAbsolute(update.path) ? update.path : path.resolve(update.path)
        yield* Queue.offer(queue, { kind: "change", path: relPath, type }).pipe(Effect.ignore)
      }
    }),
  )
}
