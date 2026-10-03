export * as Watcher from "./watcher"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { Cause, Context, Duration, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { lazy } from "../util/lazy"
import { Ignore } from "./ignore"
import { Protected } from "./protected"

declare const OPENCODE_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000
const WATCH_QUEUE_CAPACITY = 1024
// Bursts of Parcel callbacks for the same path (save storms, build output)
// collapse to one publish per path within this window.
const COALESCE_WINDOW = Duration.millis(50)
const COALESCE_MAX_EVENTS = 256

// Watcher-only: do NOT put these in shared Ignore.PATTERNS. Config loaders
// must still discover `.banyancode/agents` etc. The indexer writes under
// `.banyancode/*.db*` which would otherwise re-fire file.watcher.updated
// and feed the codegraph auto-update loop.
const WATCHER_ONLY_IGNORES = [".banyancode", "**/*.db", "**/*.db-wal", "**/*.db-shm", "**/*.db-journal"]

export const Event = {
  Updated: EventV2.define({
    type: "file.watcher.updated",
    schema: {
      file: Schema.String,
      event: Schema.Literals(["add", "change", "unlink"]),
    },
  }),
}

export type FileChange = { file: string; event: "add" | "change" | "unlink" }
type QueueEvent = { kind: "change"; change: FileChange } | { kind: "error"; cause: unknown }

// Last-wins per path: a burst of Parcel updates for the same file (add then
// several changes, change then unlink) publishes once with the final state.
// Downstream consumers (EventV2 listeners, SSE fanout, codegraph auto-update)
// only ever see the coalesced event, never the raw burst.
export function coalesceFileChanges(changes: ReadonlyArray<FileChange>): FileChange[] {
  const latest = new Map<string, FileChange>()
  for (const change of changes) latest.set(change.file, change)
  return [...latest.values()]
}

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
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

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (yield* Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return Service.of({})

    const backend = getBackend()
    const location = yield* Location.Service
    if (!backend) {
      yield* Effect.logError("watcher backend not supported", {
        directory: location.directory,
        platform: process.platform,
      })
      return Service.of({})
    }

    const w = watcher()
    if (!w) return Service.of({})

    yield* Effect.logInfo("watcher backend", { directory: location.directory, platform: process.platform, backend })
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service

    // Sliding queue + synchronous offers + coalescing drain. Parcel callbacks
    // fire on a native thread and cannot await Effect, so the callback uses
    // `offerUnsafe` (never suspends, no fiber at all) and a single forkScoped
    // drain fiber publishes through EventV2 in the layer's Effect context,
    // which gives the publish call access to Location.Service for event
    // stamping. The sliding queue drops the oldest entries under pressure
    // instead of suspending a per-batch fiber (unbounded fiber growth when
    // the queue is full) or growing memory without bound. The drain groups
    // bursts within COALESCE_WINDOW and publishes one event per path, so
    // raw watcher bursts never reach the SSE fanout or the TUI.
    const queue = yield* Queue.sliding<QueueEvent>(WATCH_QUEUE_CAPACITY)
    const subscriptions: ParcelWatcher.AsyncSubscription[] = []
    const drainFiber = yield* Effect.forkScoped(
      Stream.fromQueue(queue).pipe(
        Stream.groupedWithin(COALESCE_MAX_EVENTS, COALESCE_WINDOW),
        Stream.mapEffect(
          (batch) =>
            Effect.gen(function* () {
              const items = Array.from(batch)
              for (const item of items) {
                if (item.kind === "error") {
                  yield* Effect.logWarning("watcher parcel callback error", {
                    cause: Cause.pretty(Cause.fail(item.cause)),
                  })
                }
              }
              for (const change of coalesceFileChanges(
                items.flatMap((item) => (item.kind === "change" ? [item.change] : [])),
              )) {
                yield* events.publish(Event.Updated, change)
              }
            }),
          { concurrency: 1 },
        ),
        Stream.runDrain,
      ),
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(drainFiber).pipe(Effect.ignore)
        yield* Queue.shutdown(queue)
        yield* Effect.promise(() => Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe())))
      }),
    )

    const callback: ParcelWatcher.SubscribeCallback = (error, updates) => {
      if (error) {
        Queue.offerUnsafe(queue, { kind: "error", cause: error })
        return
      }
      // Fully synchronous: no runFork per batch. A sliding queue never
      // backpressures, so a flood drops the oldest entries instead of
      // parking a fiber per batch (unbounded fiber growth).
      for (const update of updates) {
        const event: "add" | "change" | "unlink" =
          update.type === "create" ? "add" : update.type === "delete" ? "unlink" : "change"
        Queue.offerUnsafe(queue, { kind: "change", change: { file: update.path, event } })
      }
    }

    const subscribe = (directory: string, ignore: string[]) => {
      const pending = w.subscribe(directory, callback, { ignore, backend })
      return Effect.promise(() => pending).pipe(
        Effect.tap((subscription) => Effect.sync(() => subscriptions.push(subscription))),
        Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
        Effect.catchCause((cause) => {
          pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
          return Effect.logError("failed to subscribe", { directory, cause: Cause.pretty(cause) })
        }),
      )
    }

    const config = (yield* (yield* Config.Service).entries())
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((item) => item.info.watcher?.ignore ?? [])
    yield* Effect.forkScoped(
      subscribe(location.directory, [
        ...Ignore.PATTERNS,
        ...WATCHER_ONLY_IGNORES,
        ...config,
        ...protecteds(location.directory),
      ]),
    )

    if (location.vcs?.type === "git") {
      const resolved = yield* git.dir(location.directory)
      const vcs = resolved ? yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved))) : undefined
      if (vcs && !config.includes(".git") && !config.includes(vcs) && (!resolved || !config.includes(resolved))) {
        const ignore = (yield* fs.readDirectoryEntries(vcs).pipe(Effect.catch(() => Effect.succeed([])))).flatMap(
          (entry) => (entry.name === "HEAD" ? [] : [entry.name]),
        )
        yield* Effect.forkScoped(subscribe(vcs, ignore))
      }
    }

    return Service.of({})
  }).pipe(
    Effect.catchCause((cause) => {
      return Effect.logError("failed to init watcher service", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(Service.of({})),
      )
    }),
  ),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer), Layer.provide(Git.defaultLayer))