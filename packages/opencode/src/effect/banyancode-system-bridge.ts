import { Effect, Queue } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"

export const applySystemMonitorBridge = Effect.gen(function* () {
  const monitor = yield* Banyan.SystemMonitorService
  const events = yield* EventV2Bridge.Service

  const queue = yield* monitor.events()

  const work = Effect.gen(function* () {
    while (true) {
      const status = yield* Queue.take(queue)
      yield* events.publish(Banyan.SystemMonitor.Updated, status)
    }
  })

  yield* Effect.forkIn(work, yield* Effect.scope)
})
