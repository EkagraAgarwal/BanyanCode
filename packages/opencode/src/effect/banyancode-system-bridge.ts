import { Duration, Effect, Option, Queue } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Banyan } from "@opencode-ai/core/banyancode"
import { RuntimeFlags } from "@/effect/runtime-flags"

/**
 * Downstream demand for system-monitor sampling. EventV2 exposes no
 * subscriber count, so SSE handlers (the only path to viewers) bump this
 * counter for the lifetime of each connection, and the drain loop below
 * holds a single monitor lease only while the count is above zero. With no
 * viewers the monitor tick skips sampling entirely.
 */
let demandCount = 0
export const SystemMonitorDemand = {
  subscribe(): void {
    demandCount++
  },
  unsubscribe(): void {
    demandCount = Math.max(0, demandCount - 1)
  },
  count(): number {
    return demandCount
  },
  resetForTests(): void {
    demandCount = 0
  },
}

export const applySystemMonitorBridge = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return
  const monitorOpt = yield* Effect.serviceOption(Banyan.SystemMonitorService)
  const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)
  if (Option.isNone(monitorOpt) || Option.isNone(eventsOpt)) return

  const monitor = monitorOpt.value
  const events = eventsOpt.value
  const queue = yield* monitor.events()

  // Defensive drain. The producer is a `Queue.bounded(60)` sampled every few
  // seconds, so a single stuck publish blocks the queue and freezes the
  // sampler — surfacing to the user as "SYSTEM stuck at 97% CPU / 14.2 GB memory".
  //
  // Per-event publish failures are logged and skipped (drain continues).
  // An outer catchCause lets us log a clean shutdown cause instead of an
  // unhandled rejection on the detached fiber. Same shape as
  // banyancode-codegraph-bridge.ts.
  //
  // The loop holds a monitor sampling lease only while SSE demand exists
  // (SystemMonitorDemand above). With no viewers it sleeps instead of taking,
  // so the monitor tick skips sampling and nothing is published.
  const work = Effect.gen(function* () {
    let release: Effect.Effect<void> | undefined
    const dropLease = Effect.suspend(() => release ?? Effect.void)
    const loop = Effect.gen(function* () {
      while (true) {
        if (SystemMonitorDemand.count() <= 0) {
          if (release !== undefined) {
            yield* release
            release = undefined
          }
          yield* Effect.sleep(Duration.millis(250))
          continue
        }
        if (release === undefined) {
          release = yield* monitor.subscribe()
        }
        const status = yield* Queue.take(queue)
        yield* events.publish(Banyan.SystemMonitor.Updated, status).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("system-bridge: publish failed; dropping", { cause }),
          ),
        )
      }
    })
    yield* loop.pipe(Effect.ensuring(dropLease))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("system-bridge: drain loop failed; stopping", { cause }),
    ),
  )

  yield* Effect.forkDetach(work)
})
