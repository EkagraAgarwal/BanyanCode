import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref } from "effect"
import { applyCodegraphBuildBridge } from "@/effect/banyancode-codegraph-bridge"
import { Service as CodegraphBuildServiceService, type State } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

type BuildQueueEvent = { type: "banyancode.codegraph.build"; properties: State }
type Published = { definition: unknown; data: unknown }

const makeMockBuildService = async (events: Array<BuildQueueEvent>) => {
  const queue = await Effect.runPromise(Queue.unbounded<BuildQueueEvent>())
  for (const e of events) await Effect.runPromise(Queue.offer(queue, e))
  return Layer.succeed(
    CodegraphBuildServiceService,
    CodegraphBuildServiceService.of({
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

describe("codegraph-bridge", () => {
  test("bridge consumes from queue and publishes events", async () => {
    const events: BuildQueueEvent[] = [
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 5, total: 10 } },
      { type: "banyancode.codegraph.build", properties: { status: "completed", done: 10, total: 10 } },
    ]
    const buildServiceLayer = await makeMockBuildService(events)
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const flagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: undefined,
      } as any),
    )

    const testLayer = Layer.mergeAll(buildServiceLayer, eventV2Layer, flagsLayer)

    await Effect.runPromise(
      applyCodegraphBuildBridge.pipe(
        Effect.tap(() => Effect.sleep(50)),
        Effect.provide(testLayer),
        Effect.scoped,
      ),
    )

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(2)
    expect(result[0].data).toEqual({ status: "running", done: 5, total: 10 })
    expect(result[1].data).toEqual({ status: "completed", done: 10, total: 10 })
  })

  test("bridge no-ops when banyancodeEnable is false", async () => {
    const events: BuildQueueEvent[] = [
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 5, total: 10 } },
    ]
    const buildServiceLayer = await makeMockBuildService(events)
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const flagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: false,
        banyancodeEmbeddingModel: undefined,
      } as any),
    )

    const testLayer = Layer.mergeAll(buildServiceLayer, eventV2Layer, flagsLayer)

    await Effect.runPromise(applyCodegraphBuildBridge.pipe(Effect.provide(testLayer), Effect.scoped))

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(0)
  })

  test("bridge handles multiple events in order", async () => {
    const events: BuildQueueEvent[] = [
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 1, total: 3 } },
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 2, total: 3 } },
      { type: "banyancode.codegraph.build", properties: { status: "completed", done: 3, total: 3 } },
    ]
    const buildServiceLayer = await makeMockBuildService(events)
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const flagsLayer = Layer.succeed(
      RuntimeFlags.Service,
      RuntimeFlags.Service.of({
        banyancodeEnable: true,
        banyancodeEmbeddingModel: undefined,
      } as any),
    )

    const testLayer = Layer.mergeAll(buildServiceLayer, eventV2Layer, flagsLayer)

    await Effect.runPromise(
      applyCodegraphBuildBridge.pipe(
        Effect.tap(() => Effect.sleep(50)),
        Effect.provide(testLayer),
        Effect.scoped,
      ),
    )

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(3)
    const data0 = result[0].data as State
    const data1 = result[1].data as State
    const data2 = result[2].data as State
    expect(data0.done).toBe(1)
    expect(data1.done).toBe(2)
    expect(data2.done).toBe(3)
    expect(data2.status).toBe("completed")
  })
})
