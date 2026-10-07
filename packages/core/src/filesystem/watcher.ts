export * as Watcher from "./watcher"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { Cause, Context, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
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

export const Event = {
  Updated: EventV2.define({
    type: "file.watcher.updated",
    schema: {
      file: Schema.String,
      event: Schema.Literals(["add", "change", "unlink"]),
    },
  }),
}

type FileChange = { file: string; event: "add" | "change" | "unlink" }
type QueueEvent = { kind: "change"; change: FileChange } | { kind: "error"; cause: unknown }

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

    // Queue + bounded drain fiber pattern. Parcel callbacks fire on a native
    // thread and cannot await Effect — we offer each batch into a bounded
    // queue (one short fiber per Parcel callback batch, not per event) and a
    // single forkScoped drain fiber publishes through EventV2 in the layer's
    // Effect context, which gives the publish call access to Location.Service
    // for event stamping. Replaces the per-event `Effect.runForkWith` that
    // spawned one fiber per Parcel update (banned per AGENTS.md lesson
    // "Hot-path callbacks that need Effect queue handoff").
    const queue = yield* Queue.bounded<QueueEvent>(WATCH_QUEUE_CAPACITY)
    const subscriptions: ParcelWatcher.AsyncSubscription[] = []
    const drainFiber = yield* Effect.forkScoped(
      Stream.fromQueue(queue).pipe(
        Stream.mapEffect((event) => {
          switch (event.kind) {
            case "change":
              return events.publish(Event.Updated, event.change)
            case "error":
              return Effect.logWarning("watcher parcel callback error", { cause: Cause.pretty(Cause.fail(event.cause)) })
          }
        }, { concurrency: 1 }),
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
        Effect.runFork(Queue.offer(queue, { kind: "error", cause: error }).pipe(Effect.ignore))
        return
      }
      // One short fiber per Parcel batch (NOT per event). All updates from this
      // batch are offered sequentially inside the fiber; bounded Queue is the
      // backpressure window so a flood can't spawn unbounded fibers.
      Effect.runFork(
        Effect.gen(function* () {
          for (const update of updates) {
            const event: "add" | "change" | "unlink" =
              update.type === "create" ? "add" : update.type === "delete" ? "unlink" : "change"
            yield* Queue.offer(queue, { kind: "change", change: { file: update.path, event } }).pipe(Effect.ignore)
          }
        }),
      )
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
      subscribe(location.directory, [...Ignore.PATTERNS, ...config, ...protecteds(location.directory)]),
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