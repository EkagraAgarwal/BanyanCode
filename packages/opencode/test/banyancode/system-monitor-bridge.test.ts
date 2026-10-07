import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref } from "effect"
import { applySystemMonitorBridge } from "@/effect/banyancode-system-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

type SystemStatus = Banyan.SystemMonitor.SystemStatus
type SystemStatusQueueEvent = SystemStatus
type Published = { definition: unknown; data: unknown }

const makeMockMonitorService = async (events: Array<SystemStatusQueueEvent>) => {
  const queue = await Effect.runPromise(Queue.unbounded<SystemStatusQueueEvent>())
  for (const e of events) await Effect.runPromise(Queue.offer(queue, e))
  return Layer.succeed(
    Banyan.SystemMonitorService,
    Banyan.SystemMonitorService.of({
      status: () => Effect.succeed(events[events.length - 1] ?? ({} as SystemStatus)),
      watch: () => Effect.die("unused"),
      events: () => Effect.succeed(queue),
    } as any),
  )
}

const makeMockEventV2Bridge = async (publishBehavior: "ok" | "fail-first" | "fail-all") => {
  const published = await Effect.runPromise(Ref.make<Array<Published>>([]))
  const attempts = await Effect.runPromise(Ref.make<number>(0))
  const layer = Layer.succeed(
    EventV2Bridge.Service,
    EventV2Bridge.Service.of({
      publish: (_def: unknown, data: unknown) =>
        Effect.gen(function* () {
          yield* Ref.update(attempts, (n) => n + 1)
          if (publishBehavior === "fail-all") {
            return yield* Effect.fail(new Error("publish failed"))
          }
          if (publishBehavior === "fail-first") {
            const n = yield* Ref.get(attempts)
            if (n === 1) {
              return yield* Effect.fail(new Error("first publish failed"))
            }
          }
          yield* Ref.update(published, (p) => [...p, { definition: undefined, data } as Published])
        }),
      listen: () => Effect.succeed(() => Effect.void),
    } as any),
  )
  return { published, attempts, layer }
}

const flagsLayer = (enabled: boolean) =>
  Layer.succeed(
    RuntimeFlags.Service,
    RuntimeFlags.Service.of({
      banyancodeEnable: enabled,
      banyancodeEmbeddingModel: undefined,
    } as any),
  )

describe("system-monitor-bridge", () => {
  test("bridge consumes from queue and publishes events", async () => {
    const events: SystemStatusQueueEvent[] = [
      {
        cpuPercent: 20,
        memoryUsedBytes: 8 * 1024 * 1024 * 1024,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        platform: "linux",
      },
      {
        cpuPercent: 30,
        memoryUsedBytes: 9 * 1024 * 1024 * 1024,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        platform: "linux",
      },
    ]
    const monitorLayer = await makeMockMonitorService(events)
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge("ok")

    const testLayer = Layer.mergeAll(monitorLayer, eventV2Layer, flagsLayer(true))

    await Effect.runPromise(
      applySystemMonitorBridge.pipe(
        Effect.tap(() => Effect.sleep(50)),
        Effect.provide(testLayer),
        Effect.scoped,
      ),
    )

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(2)
    expect((result[0].data as SystemStatus).cpuPercent).toBe(20)
    expect((result[1].data as SystemStatus).cpuPercent).toBe(30)
  })

  test("bridge no-ops when banyancodeEnable is false", async () => {
    const events: SystemStatusQueueEvent[] = [
      {
        cpuPercent: 50,
        memoryUsedBytes: 1,
        memoryTotalBytes: 2,
        platform: "linux",
      },
    ]
    const monitorLayer = await makeMockMonitorService(events)
    const { published, layer: eventV2Layer } = await makeMockEventV2Bridge("ok")

    const testLayer = Layer.mergeAll(monitorLayer, eventV2Layer, flagsLayer(false))

    await Effect.runPromise(applySystemMonitorBridge.pipe(Effect.provide(testLayer), Effect.scoped))

    const result = await Effect.runPromise(Ref.get(published))
    expect(result.length).toBe(0)
  })

  // Regression for the "SYSTEM stuck at high utilization" bug. The drain loop
  // must swallow per-event publish failures and keep consuming the queue —
  // otherwise the producer (a Queue.bounded(60)) backs up, the next tick
  // blocks on offer, and the SYSTEM widget freezes on whatever value it last
  // saw.
  test("bridge survives a transient publish failure and keeps draining", async () => {
    const events: SystemStatusQueueEvent[] = [
      {
        cpuPercent: 97,
        memoryUsedBytes: 14 * 1024 * 1024 * 1024,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        platform: "linux",
      },
      {
        cpuPercent: 20,
        memoryUsedBytes: 8 * 1024 * 1024 * 1024,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        platform: "linux",
      },
      {
        cpuPercent: 15,
        memoryUsedBytes: 7 * 1024 * 1024 * 1024,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        platform: "linux",
      },
    ]
    const monitorLayer = await makeMockMonitorService(events)
    const { published, attempts, layer: eventV2Layer } = await makeMockEventV2Bridge("fail-first")

    const testLayer = Layer.mergeAll(monitorLayer, eventV2Layer, flagsLayer(true))

    await Effect.runPromise(
      applySystemMonitorBridge.pipe(
        Effect.tap(() => Effect.sleep(50)),
        Effect.provide(testLayer),
        Effect.scoped,
      ),
    )

    const attemptCount = await Effect.runPromise(Ref.get(attempts))
    const result = await Effect.runPromise(Ref.get(published))
    expect(attemptCount).toBe(3)
    expect(result.length).toBe(2)
    expect((result[0].data as SystemStatus).cpuPercent).toBe(20)
    expect((result[1].data as SystemStatus).cpuPercent).toBe(15)
  })
})