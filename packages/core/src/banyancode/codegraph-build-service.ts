export * as CodegraphBuildService from "./codegraph-build-service"

import { Cause, Context, Effect, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import { CodegraphIndexer } from "./codegraph-indexer"
import { EventV2 } from "../event"

export const State = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  root: Schema.optional(Schema.String),
  done: Schema.Number,
  total: Schema.Number,
  currentFile: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  result: Schema.optional(
    Schema.Struct({
      indexed: Schema.Number,
      skipped: Schema.Number,
      duration_ms: Schema.Number,
    }),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/CodegraphBuildState" })

export type State = typeof State.Type

export const BuildEvent = EventV2.define({
  type: "banyancode.codegraph.build",
  schema: State.fields,
})

export interface Interface {
  readonly status: () => Effect.Effect<State, never, never>
  readonly start: (input: { root: string; force?: boolean }) => Effect.Effect<void, never, never>
  readonly cancel: () => Effect.Effect<void, never, never>
  readonly events: () => Queue.Dequeue<{ type: "banyancode.codegraph.build"; properties: State }>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphBuildService") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const state = yield* Ref.make<State>({ status: "idle", done: 0, total: 0 })
      const events = yield* Queue.unbounded<{ type: "banyancode.codegraph.build"; properties: State }>().pipe(Effect.orDie)
      return Service.of({
        status: () => Ref.get(state),
        start: () => Effect.void,
        cancel: () => Effect.void,
        events: () => events,
      })
    }

    const indexer = yield* CodegraphIndexer.Service
    const eventBus = yield* EventV2.Service
    const state = yield* Ref.make<State>({ status: "idle", done: 0, total: 0 })
    const inFlight = yield* Ref.make<Option.Option<Fiber.Fiber<void, CodegraphIndexer.CodegraphError>>>(Option.none())
    const events = yield* Queue.unbounded<{ type: "banyancode.codegraph.build"; properties: State }>().pipe(Effect.orDie)

    const publish = (s: State) => Queue.offer(events, { type: "banyancode.codegraph.build", properties: s }).pipe(Effect.orDie)

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(events)
          yield* eventBus.publish(BuildEvent, event.properties)
        }),
      ),
    )

    const start: Interface["start"] = (input) =>
      Effect.gen(function* () {
        const currentFiber = yield* Ref.get(inFlight)
        if (Option.isSome(currentFiber)) yield* Fiber.interrupt(currentFiber.value)

        yield* indexer.cancel()
        const initial: State = { status: "running", root: input.root, done: 0, total: 0, startedAt: Date.now() }
        yield* Ref.set(state, initial)
        yield* publish(initial)

        const work = Effect.gen(function* () {
          const startTime = Date.now()
          const result = yield* indexer.index({
            root: input.root,
            force: input.force ?? false,
            onProgress: Effect.fn("CodegraphBuildService.onProgress")(function* ({ file, done, total }) {
              const next: State = { ...initial, done, total, currentFile: file }
              yield* Ref.set(state, next)
              yield* publish(next)
            }),
          })
          const doneState: State = {
            status: "completed",
            root: initial.root,
            done: result.indexed + result.skipped,
            total: result.indexed + result.skipped,
            startedAt: initial.startedAt,
            result: { indexed: result.indexed, skipped: result.skipped, duration_ms: Date.now() - startTime },
          }
          yield* Ref.set(state, doneState)
          yield* publish(doneState)
        })

        const forkWork = work.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const current = yield* Ref.get(state)
              if (current.status === "running") {
                const err = Cause.squash(cause)
                const errorMsg = err instanceof Error ? err.message : String(err)
                const next: State = { ...initial, status: "failed", error: errorMsg }
                yield* Ref.set(state, next)
                yield* publish(next)
              }
            }),
          ),
        )

        // Use runFork to execute the work in the background
        const context = yield* Effect.context()
        const runFork = Effect.runForkWith(context)
        const fiber = runFork(forkWork)
        yield* Ref.set(inFlight, Option.some(fiber))
      })

    const cancel: Interface["cancel"] = () =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(inFlight)
        if (Option.isSome(fiber)) {
          yield* Fiber.interrupt(fiber.value)
          yield* Ref.set(inFlight, Option.none())
          const current = yield* Ref.get(state)
          if (current.status === "running") {
            const next: State = { ...current, status: "cancelled" }
            yield* Ref.set(state, next)
            yield* publish(next)
          }
        }
        yield* indexer.cancel()
      })

    const status: Interface["status"] = () => Ref.get(state)
    const eventsDequeue: Interface["events"] = () => events

    return Service.of({ status, start, cancel, events: eventsDequeue })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphIndexer.defaultLayer))
