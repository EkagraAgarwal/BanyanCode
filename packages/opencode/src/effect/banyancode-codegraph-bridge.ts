import { Effect, Option, Queue } from "effect"
import { Service as CodegraphBuildServiceService, BuildEvent as CodegraphBuildServiceBuildEvent } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { EventV2Bridge } from "@/event-v2-bridge"

export const applyCodegraphBuildBridge = Effect.gen(function* () {
  const buildServiceOpt = yield* Effect.serviceOption(CodegraphBuildServiceService)
  if (Option.isNone(buildServiceOpt)) return

  const buildService = buildServiceOpt.value
  const queue = buildService.events()
  const bridgeOpt = yield* Effect.serviceOption(EventV2Bridge.Service)

  // Phase 2: defensive drain. The queue shutdown cause (interrupt) ends the
  // loop via catchCause — that path is normal at runtime teardown.
  // Per-event publish failures are logged and skipped so a slow EventV2Bridge
  // cannot stall the drain. If EventV2Bridge is missing, drain anyway and
  // log per-event — callers like /health or test harnesses can still exercise
  // the build service without it. `bridgeOpt` is captured in closure so the
  // drain's R-channel does NOT widen to require EventV2Bridge when it's
  // absent at composition time.
  const work = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (Option.isSome(bridgeOpt)) {
        yield* bridgeOpt.value.publish(CodegraphBuildServiceBuildEvent, event.properties).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codegraph-bridge: publish failed", { cause }),
          ),
        )
      } else {
        yield* Effect.logInfo("codegraph-bridge: EventV2Bridge not in scope; dropping event")
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("codegraph-bridge: drain loop failed; stopping", { cause }),
    ),
  )

  // Detach from the caller scope so the drain fiber survives the bridge's
  // calling context. Same reason as codegraph-build-service.start(): forkIn
  // would require Scope in context, which is not available here.
  yield* Effect.forkDetach(work)
})
