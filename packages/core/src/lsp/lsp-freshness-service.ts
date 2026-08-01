export * as LspFreshnessService from "./lsp-freshness-service"

import { Cause, Context, Effect, Fiber, Layer, Queue, Ref, Schema, Stream } from "effect"
import { LspInvalidationRepo, type InvalidationEvent, type LspInvalidationKind } from "../banyancode/lsp-invalidation-repo"
import { EventV2 } from "../event"
import { startLspFreshnessWatcher, type LspWatcherHandle, type LspWatcherEvent } from "./lsp-freshness-watcher"

export const LspFreshnessEvent = EventV2.define({
  type: "banyancode.lsp.freshness",
  schema: {
    path: Schema.String,
    kind: Schema.Literals(["file_changed", "file_deleted", "indexed", "rebuilt"]),
  },
})

export type LspFreshnessStreamEvent = {
  readonly kind: "file_changed" | "file_deleted"
  readonly path: string
}

export interface LspFreshnessStatus {
  readonly running: boolean
  readonly root?: string
  readonly startedAt?: number
  readonly lastEventAt?: number
  readonly eventsObserved: number
  readonly eventsPersisted: number
}

export interface Interface {
  readonly start: (root: string) => Effect.Effect<void, never, never>
  readonly stop: () => Effect.Effect<void, never, never>
  readonly isRunning: () => Effect.Effect<boolean, never, never>
  readonly status: () => Effect.Effect<LspFreshnessStatus, never, never>
  /**
   * Public event stream. Emits ONLY the file-level events the freshness
   * service forwards to downstream consumers (LSPBridge, tool guides, etc).
   * Queue ownership is single-consumer (per AGENTS.md "Effect Queue is
   * single-consumer" rule): the layer below attaches the internal drain
   * fiber and DOES NOT consume this stream itself.
   */
  readonly events: () => Stream.Stream<LspFreshnessStreamEvent, never, never>
  readonly invalidate: (input: {
    kind: LspInvalidationKind
    path: string
    payload?: unknown
  }) => Effect.Effect<void, never, never>
  readonly recordFromEvent: (event: LspWatcherEvent) => Effect.Effect<void, never, never>
  readonly listRecent: (limit: number) => Effect.Effect<ReadonlyArray<InvalidationEvent>, never, never>
  readonly markConsumed: (ids: ReadonlyArray<number>) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/LspFreshnessService") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const STREAM_QUEUE_CAPACITY = 256

type RuntimeState = {
  readonly root: string
  readonly startedAt: number
  readonly drainFiber: Fiber.Fiber<unknown, unknown>
  readonly handle: LspWatcherHandle
  readonly streamQueue: Queue.Queue<LspFreshnessStreamEvent>
}

const watcherEventToFreshness = (event: LspWatcherEvent): LspFreshnessStreamEvent | undefined => {
  if (event.kind !== "change") return undefined
  const kind: LspFreshnessStreamEvent["kind"] = event.type === "unlink" ? "file_deleted" : "file_changed"
  return { kind, path: event.path }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      // BanyanCode disabled: surface a no-op service. The stream is a never
      // ending empty queue so `events()` callers see no events and `start`
      // does nothing. Mirrors CodegraphBuildService's disabled branch.
      const events = yield* Queue.unbounded<LspFreshnessStreamEvent>()
      const statusRef = yield* Ref.make<LspFreshnessStatus>({ running: false, eventsObserved: 0, eventsPersisted: 0 })
      return Service.of({
        start: () => Effect.void,
        stop: () => Effect.void,
        isRunning: () => Ref.get(statusRef).pipe(Effect.map((s) => s.running)),
        status: () => Ref.get(statusRef),
        events: () => Stream.fromQueue(events),
        invalidate: () => Effect.void,
        recordFromEvent: () => Effect.void,
        listRecent: () => Effect.succeed([] as const),
        markConsumed: () => Effect.void,
      })
    }

    const repo = yield* LspInvalidationRepo.Service
    const statusRef = yield* Ref.make<LspFreshnessStatus>({ running: false, eventsObserved: 0, eventsPersisted: 0 })
    // The Ref holds the active subscription (if any). The public `events()`
    // stream is a view onto the current subscription's queue; if the
    // subscription is torn down the queue shuts down, and `events()` will
    // yield a stream that immediately ends. We swap the queue on every
    // start() so consumers see a fresh stream each time.
    const runtimeRef = yield* Ref.make<RuntimeState | undefined>(undefined)

    const start: Interface["start"] = (root) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(runtimeRef)
        if (current && current.root === root) return
        if (current) yield* stopRuntime(runtimeRef, statusRef)

        const streamQueue = yield* Queue.bounded<LspFreshnessStreamEvent>(STREAM_QUEUE_CAPACITY)
        const { handle, events: watcherEvents } = yield* startLspFreshnessWatcher(root)
        const startedAt = Date.now()

        // Single drain fiber (per AGENTS.md "Effect Queue is single-consumer"
        // and "Hot-path callbacks that need Effect queue handoff"). This
        // fiber is the ONLY consumer of `watcherEvents`; the public stream
        // is `streamQueue`. Mapping (Parcel event → freshness event) +
        // persistence + queue offer all happen here, so a slow DB write
        // doesn't block Parcel delivery.
        const drainFiber = yield* Effect.forkDetach(
          Stream.fromQueue(watcherEvents).pipe(
            Stream.mapEffect(
              (event) =>
                Effect.gen(function* () {
                  yield* recordAndPublish(event, streamQueue, statusRef, repo)
                  if (event.kind === "change") {
                    const kind: LspInvalidationKind = event.type === "unlink" ? "file_deleted" : "file_changed"
                    const eventBus = yield* Effect.serviceOption(EventV2.Service)
                    if (eventBus._tag === "Some") {
                      yield* eventBus.value
                        .publish(LspFreshnessEvent, { path: event.path, kind })
                        .pipe(Effect.ignore)
                    }
                  }
                }),
              { concurrency: 4 },
            ),
            Stream.runDrain,
          ),
        )

        const next: RuntimeState = { root, startedAt, drainFiber, handle, streamQueue }
        yield* Ref.set(runtimeRef, next)
        yield* Ref.update(statusRef, (s) => ({ ...s, running: true, root, startedAt }))
        yield* Effect.logInfo("lsp-freshness: started", { root })
      })

    const stop: Interface["stop"] = () => stopRuntime(runtimeRef, statusRef)

    const isRunning: Interface["isRunning"] = () =>
      Ref.get(runtimeRef).pipe(Effect.map((s) => s !== undefined))

    const status: Interface["status"] = () =>
      Effect.gen(function* () {
        const s = yield* Ref.get(statusRef)
        const r = yield* Ref.get(runtimeRef)
        return {
          ...s,
          running: r !== undefined,
          ...(r ? { root: r.root, startedAt: r.startedAt } : {}),
        }
      })

    const events: Interface["events"] = () =>
      Stream.unwrap(
        Ref.get(runtimeRef).pipe(
          Effect.map((r) => (r ? Stream.fromQueue(r.streamQueue) : Stream.empty)),
        ),
      )

    const invalidate: Interface["invalidate"] = (input) =>
      Effect.gen(function* () {
        const recorded = yield* repo.recordEvent(input)
        yield* Ref.update(statusRef, (current) => ({
          ...current,
          lastEventAt: Math.floor(Date.now() / 1000),
          eventsObserved: current.eventsObserved + 1,
          eventsPersisted: current.eventsPersisted + 1,
        }))
        const r = yield* Ref.get(runtimeRef)
        if (r && (input.kind === "file_changed" || input.kind === "file_deleted")) {
          yield* Queue.offer(r.streamQueue, { kind: input.kind, path: input.path }).pipe(Effect.ignore)
        }
        return void recorded.id
      })

    const listRecent: Interface["listRecent"] = (limit) => repo.listRecent(limit)
    const markConsumed: Interface["markConsumed"] = (ids) => repo.markConsumed(ids)

    const recordFromEvent: Interface["recordFromEvent"] = (event) =>
      Effect.gen(function* () {
        const r = yield* Ref.get(runtimeRef)
        if (!r) return
        yield* recordAndPublish(event, r.streamQueue, statusRef, repo)
      })

    return Service.of({
      start,
      stop,
      isRunning,
      status,
      events,
      invalidate,
      recordFromEvent,
      listRecent,
      markConsumed,
    })
  }),
)

const recordAndPublish = (
  event: LspWatcherEvent,
  streamQueue: Queue.Queue<LspFreshnessStreamEvent>,
  statusRef: Ref.Ref<LspFreshnessStatus>,
  repo: LspInvalidationRepo.Interface,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    if (event.kind === "error") {
      yield* Effect.logWarning("lsp-freshness: parcel callback error", {
        cause: Cause.pretty(Cause.fail(event.cause)),
      })
      return
    }
    const stream = watcherEventToFreshness(event)
    if (!stream) return
    const recorded = yield* repo.recordEvent({
      kind: stream.kind,
      path: stream.path,
      payload: { watcherType: event.type },
    })
    yield* Ref.update(statusRef, (current) => ({
      ...current,
      lastEventAt: Math.floor(Date.now() / 1000),
      eventsObserved: current.eventsObserved + 1,
      eventsPersisted: current.eventsPersisted + 1,
    }))
    yield* Queue.offer(streamQueue, stream).pipe(Effect.ignore)
    return void recorded.id
  })

const stopRuntime = (
  runtimeRef: Ref.Ref<RuntimeState | undefined>,
  statusRef: Ref.Ref<LspFreshnessStatus>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(runtimeRef)
    if (!current) return
    yield* Fiber.interrupt(current.drainFiber).pipe(Effect.ignore)
    yield* current.handle.stop()
    yield* Queue.shutdown(current.streamQueue)
    yield* Ref.set(runtimeRef, undefined)
    yield* Ref.update(statusRef, (s) => ({ ...s, running: false }))
    yield* Effect.logInfo("lsp-freshness: stopped")
  })

export const defaultLayer = layer.pipe(Layer.provide(LspInvalidationRepo.defaultLayer))
