import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref } from "effect"
import { applyCodegraphEmbedBridge } from "@/effect/banyancode-embed-bridge"
import { Service as CodegraphEmbedServiceService, type State } from "@opencode-ai/core/banyancode/codegraph-embed-service"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

type EmbedQueueEvent = { type: "banyancode.codeembed.build"; properties: State }
type Published = { definition: unknown; data: unknown }

const makeMockEmbedService = async (events: Array<EmbedQueueEvent>) => {
  const queue = await Effect.runPromise(Queue.unbounded<EmbedQueueEvent>())
  for (const e of events) await Effect.runPromise(Queue.offer(queue, e))
  return Layer.succeed(
    CodegraphEmbedServiceService,
    CodegraphEmbedServiceService.of({
      status: () => Effect.succeed({ status: "completed", done: 0, total: 0 } as State),
      start: () => Effect.void,
      cancel: () => Effect.void,
      events: () => queue,
    }),
  )
}

const makeMockEventV2Bridge = async () => {
  const published = await Effect.runPromise(Ref.make<Array<Published>>([]))
  return {
    published,
    layer: Layer.succeed(
      EventV2Bridge.Service,
      EventV2Bridge.Service.of({
        publish: (def: unknown, data: unknown) =>
          Effect.gen(function* () {
            yield* Ref.update(published, (p) => [...p, { definition: def, data } as Published])
          }),
        listen: () => Effect.succeed(() => Effect.void),
      } as any),
    ),
  }
}

describe("codegraph-embed-bridge", () => {
  test("bridge consumes from queue and publishes events", async () => {
    const events: EmbedQueueEvent[] = [
      { type: "banyancode.codeembed.build", properties: { status: "running", done: 5, total: 10 } },
      { type: "banyancode.codeembed.build", properties: { status: "running", done: 8, total: 10 } },
      {
        type: "banyancode.codeembed.build",
        properties: {
          status: "completed",
          done: 10,
          total: 10,
          result: { embedded: 8, skipped: 2 },
        },
      },
    ]
    const embedServiceLayer = await makeMockEmbedService(events)
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const flagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: undefined,
      } as any),
    )

    const testLayer = Layer.mergeAll(embedServiceLayer, eventV2Layer, flagsLayer)

    await Effect.runPromise(
      applyCodegraphEmbedBridge.pipe(
        Effect.tap(() => Effect.sleep(50)),
        Effect.provide(testLayer),
        Effect.scoped,
      ),
    )

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(3)
    expect(result[0].data).toEqual({ status: "running", done: 5, total: 10 })
    expect(result[1].data).toEqual({ status: "running", done: 8, total: 10 })
    expect(result[2].data).toEqual({
      status: "completed",
      done: 10,
      total: 10,
      result: { embedded: 8, skipped: 2 },
    })
  })

  test("bridge no-ops when embed service is missing", async () => {
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const flagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: undefined,
      } as any),
    )

    const testLayer = Layer.mergeAll(eventV2Layer, flagsLayer)

    await Effect.runPromise(applyCodegraphEmbedBridge.pipe(Effect.provide(testLayer), Effect.scoped))

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(0)
  })

  test("bridge no-ops when EventV2Bridge is missing", async () => {
    const events: EmbedQueueEvent[] = [
      { type: "banyancode.codeembed.build", properties: { status: "running", done: 1, total: 1 } },
    ]
    const embedServiceLayer = await makeMockEmbedService(events)
    const flagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: undefined,
      } as any),
    )

    const testLayer = Layer.mergeAll(embedServiceLayer, flagsLayer)

    await Effect.runPromise(
      applyCodegraphEmbedBridge.pipe(
        Effect.tap(() => Effect.sleep(50)),
        Effect.provide(testLayer),
        Effect.scoped,
      ),
    )
  })
})
