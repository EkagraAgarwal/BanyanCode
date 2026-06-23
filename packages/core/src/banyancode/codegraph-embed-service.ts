export * as CodegraphEmbedService from "./codegraph-embed-service"

import { Cause, Context, Effect, Fiber, Layer, Option, Queue, Ref, Schema } from "effect"
import { CodegraphEmbedder } from "./codegraph-embedder"
import { EventV2 } from "../event"

export const State = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  done: Schema.Number,
  total: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  result: Schema.optional(
    Schema.Struct({
      embedded: Schema.Number,
      skipped: Schema.Number,
    }),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/CodegraphEmbedServiceState" })

export type State = typeof State.Type

export const EmbedEvent = EventV2.define({
  type: "banyancode.codeembed.build",
  schema: State.fields,
})

export interface Interface {
  readonly status: () => Effect.Effect<State, never, never>
  readonly start: (input: { file?: string }) => Effect.Effect<void, never, never>
  readonly cancel: () => Effect.Effect<void, never, never>
  readonly events: () => Queue.Dequeue<{ type: "banyancode.codeembed.build"; properties: State }>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphEmbedService") {}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      const state = yield* Ref.make<State>({ status: "idle", done: 0, total: 0 })
      const events = yield* Queue.unbounded<{ type: "banyancode.codeembed.build"; properties: State }>().pipe(Effect.orDie)
      return Service.of({
        status: () => Ref.get(state),
        start: () => Effect.void,
        cancel: () => Effect.void,
        events: () => events,
      })
    }

    const embedder = yield* CodegraphEmbedder.Service
    const eventBus = yield* EventV2.Service
    const state = yield* Ref.make<State>({ status: "idle", done: 0, total: 0 })
    const inFlight = yield* Ref.make<Option.Option<Fiber.Fiber<void, never>>>(Option.none())
    const events = yield* Queue.unbounded<{ type: "banyancode.codeembed.build"; properties: State }>().pipe(Effect.orDie)

    const publish = (s: State) =>
      Queue.offer(events, { type: "banyancode.codeembed.build", properties: s }).pipe(Effect.orDie)

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(events)
          yield* eventBus.publish(EmbedEvent, event.properties)
        }),
      ),
    )

    const start: Interface["start"] = (input) =>
      Effect.gen(function* () {
        const currentFiber = yield* Ref.get(inFlight)
        if (Option.isSome(currentFiber)) yield* Fiber.interrupt(currentFiber.value)

        const initial: State = { status: "running", done: 0, total: 0, startedAt: Date.now() }
        yield* Ref.set(state, initial)
        yield* publish(initial)

        const work = Effect.gen(function* () {
          const result = input.file
            ? yield* embedder.embedFile(input.file)
            : yield* embedder.embedAll()
          const processed = result.embedded + result.skipped
          const doneState: State = {
            status: "completed",
            done: processed,
            total: processed,
            startedAt: initial.startedAt,
            result: { embedded: result.embedded, skipped: result.skipped },
          }
          yield* Ref.set(state, doneState)
          yield* publish(doneState)
        })

        const forkWork = work.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const err = Cause.squash(cause)
              const errorMsg = err instanceof Error ? err.message : String(err)
              const next: State = { ...initial, status: "failed", error: errorMsg }
              yield* Ref.set(state, next)
              yield* publish(next)
            }),
          ),
        )

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
      })

    const status: Interface["status"] = () => Ref.get(state)
    const eventsDequeue: Interface["events"] = () => events

    return Service.of({ status, start, cancel, events: eventsDequeue })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphEmbedder.defaultLayer))