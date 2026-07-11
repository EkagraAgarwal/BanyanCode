import { Effect, Option, Queue } from "effect"
import { Service as MemoryServiceService } from "@opencode-ai/core/banyancode/memory-service"
import {
  MemoryCandidateEmitted,
  MemoryCommitted,
  MemoryPromoted,
  MemoryRejected,
} from "@opencode-ai/core/banyancode/memory-events"
import { EventV2Bridge } from "@/event-v2-bridge"

export const applyMemoryBridge = Effect.gen(function* () {
  const serviceOpt = yield* Effect.serviceOption(MemoryServiceService)
  if (Option.isNone(serviceOpt)) return

  const service = serviceOpt.value
  const queue = service.events()
  const bridgeOpt = yield* Effect.serviceOption(EventV2Bridge.Service)

  // Phase 1b: defensive drain modeled on banyancode-codegraph-bridge.ts.
  // The queue shutdown cause (interrupt) ends the loop via catchCause.
  // Per-event publish failures are logged and skipped so a slow
  // EventV2Bridge cannot stall the drain. If EventV2Bridge is missing,
  // drain anyway and log per-event — callers like /health or test
  // harnesses can still exercise the memory service without it.
  // `bridgeOpt` is captured in closure so the drain's R-channel does NOT
  // widen to require EventV2Bridge when it's absent at composition time.
  const work = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (Option.isNone(bridgeOpt)) {
        yield* Effect.logInfo("memory-bridge: EventV2Bridge not in scope; dropping event")
        continue
      }
      const bridge = bridgeOpt.value
      const props = event.properties as Record<string, unknown>
      const publishEffect: Effect.Effect<unknown, unknown, unknown> = event.type === "banyancode.memory.committed"
        ? bridge.publish(MemoryCommitted, props as never)
        : event.type === "banyancode.memory.candidate_emitted"
        ? bridge.publish(MemoryCandidateEmitted, props as never)
        : event.type === "banyancode.memory.promoted"
        ? bridge.publish(MemoryPromoted, props as never)
        : bridge.publish(MemoryRejected, props as never)
      yield* publishEffect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("memory-bridge: publish failed", { type: event.type, cause }),
        ),
      )
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("memory-bridge: drain loop failed; stopping", { cause }),
    ),
  )

  // Detach from the caller scope so the drain fiber survives the bridge's
  // calling context. Same reason as codegraph-build-service.start(): forkIn
  // would require Scope in context, which is not available here.
  yield* Effect.forkDetach(work)
})
