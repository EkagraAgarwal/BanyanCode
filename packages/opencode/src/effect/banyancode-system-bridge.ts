import { Effect, Option, Queue } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const applySystemMonitorBridge = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return
  const monitorOpt = yield* Effect.serviceOption(Banyan.SystemMonitorService)
  const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)
  if (Option.isNone(monitorOpt) || Option.isNone(eventsOpt)) return

  const monitor = monitorOpt.value
  const events = eventsOpt.value
  const queue = yield* monitor.events()

  const work = Effect.gen(function* () {
    while (true) {
      const status = yield* Queue.take(queue)
      yield* events.publish(Banyan.SystemMonitor.Updated, status)
    }
  })

  yield* Effect.forkIn(work, yield* Effect.scope)
})
