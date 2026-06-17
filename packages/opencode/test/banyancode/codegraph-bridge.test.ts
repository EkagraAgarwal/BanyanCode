import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref } from "effect"
import { codegraphBuildBridgeLayer, startCodegraphBuildBridge } from "@/effect/banyancode-codegraph-bridge"
import { Service as CodegraphBuildServiceService, type State } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { EventV2Bridge } from "@/event-v2-bridge"

type BuildQueueEvent = { type: "banyancode.codegraph.build"; properties: State }
type Published = { definition: unknown; data: unknown }

process.env.BANYANCODE_ENABLE = "1"

const makeMockBuildService = async () => {
  const queue = await Effect.runPromise(Queue.unbounded<BuildQueueEvent>())
  const layer = Layer.succeed(
    CodegraphBuildServiceService,
    CodegraphBuildServiceService.of({
      status: () => Effect.succeed({ status: "completed", done: 0, total: 0 } as State),
      start: () => Effect.void,
      cancel: () => Effect.void,
      events: () => queue,
    }),
  )
  return { queue, layer }
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
        subscribe: () => Effect.die("not used in bridge test"),
        all: () => Effect.die("not used in bridge test"),
        aggregateEvents: () => Effect.die("not used in bridge test"),
        sync: () => Effect.die("not used in bridge test"),
      } as unknown as EventV2Bridge.Service["Service"]),
    ),
  }
}

const runBridge = (testLayer: Layer.Layer<never>, queue: Queue.Queue<BuildQueueEvent>, events: BuildQueueEvent[]) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    yield* startCodegraphBuildBridge(scope)
    for (const event of events) yield* Queue.offer(queue, event)
    yield* Effect.sleep(100)
  }).pipe(Effect.provide(testLayer), Effect.scoped)

describe("codegraph-bridge", () => {
  test("bridge consumes from queue and publishes events", async () => {
    process.env.BANYANCODE_ENABLE = "1"
    const events: BuildQueueEvent[] = [
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 5, total: 10 } },
      { type: "banyancode.codegraph.build", properties: { status: "completed", done: 10, total: 10 } },
    ]
    const { queue, layer: buildServiceLayer } = await makeMockBuildService()
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const testLayer = Layer.mergeAll(buildServiceLayer, eventV2Layer)

    await Effect.runPromise(runBridge(testLayer, queue, events))

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(2)
    expect(result[0].data).toEqual({ status: "running", done: 5, total: 10 })
    expect(result[1].data).toEqual({ status: "completed", done: 10, total: 10 })
  })

  test("bridge no-ops when banyancodeEnable is false", async () => {
    process.env.BANYANCODE_ENABLE = "0"
    const events: BuildQueueEvent[] = [
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 5, total: 10 } },
    ]
    const { queue, layer: buildServiceLayer } = await makeMockBuildService()
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const testLayer = Layer.mergeAll(buildServiceLayer, eventV2Layer)

    await Effect.runPromise(runBridge(testLayer, queue, events))

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(0)
    process.env.BANYANCODE_ENABLE = "1"
  })

  test("bridge handles multiple events in order", async () => {
    process.env.BANYANCODE_ENABLE = "1"
    const events: BuildQueueEvent[] = [
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 1, total: 3 } },
      { type: "banyancode.codegraph.build", properties: { status: "running", done: 2, total: 3 } },
      { type: "banyancode.codegraph.build", properties: { status: "completed", done: 3, total: 3 } },
    ]
    const { queue, layer: buildServiceLayer } = await makeMockBuildService()
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge()
    const testLayer = Layer.mergeAll(buildServiceLayer, eventV2Layer)

    await Effect.runPromise(runBridge(testLayer, queue, events))

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
