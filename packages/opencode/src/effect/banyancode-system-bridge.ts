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

  // Defensive drain. The producer is a `Queue.bounded(60)` polled at 100ms,
  // so a single stuck publish blocks the queue and freezes the sampler —
  // surfacing to the user as "SYSTEM stuck at 97% CPU / 14.2 GB memory".
  //
  // Per-event publish failures are logged and skipped (drain continues).
  // An outer catchCause lets us log a clean shutdown cause instead of an
  // unhandled rejection on the detached fiber. Same shape as
  // banyancode-codegraph-bridge.ts.
  const work = Effect.gen(function* () {
    while (true) {
      const status = yield* Queue.take(queue)
      yield* events.publish(Banyan.SystemMonitor.Updated, status).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("system-bridge: publish failed; dropping", { cause }),
        ),
      )
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("system-bridge: drain loop failed; stopping", { cause }),
    ),
  )

  yield* Effect.forkDetach(work)
})
