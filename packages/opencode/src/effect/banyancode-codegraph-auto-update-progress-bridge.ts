import { Effect, Option, Queue } from "effect"
import {
  ProgressEvent as CodegraphAutoUpdateProgressEvent,
  Service as CodegraphAutoUpdateService,
} from "@opencode-ai/core/banyancode/codegraph-auto-update"
import { EventV2Bridge } from "@/event-v2-bridge"

export const applyCodegraphAutoUpdateProgressBridge = Effect.gen(function* () {
  const autoUpdateOpt = yield* Effect.serviceOption(CodegraphAutoUpdateService)
  if (Option.isNone(autoUpdateOpt)) return

  const queue = autoUpdateOpt.value.progressEvents()
  const bridgeOpt = yield* Effect.serviceOption(EventV2Bridge.Service)

  const work = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      if (Option.isSome(bridgeOpt)) {
        yield* bridgeOpt.value.publish(CodegraphAutoUpdateProgressEvent, event.properties).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codegraph-auto-update-progress-bridge: publish failed", { cause }),
          ),
        )
      } else {
        yield* Effect.logInfo("codegraph-auto-update-progress-bridge: EventV2Bridge not in scope; dropping event")
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("codegraph-auto-update-progress-bridge: drain loop failed; stopping", { cause }),
    ),
  )

  yield* Effect.forkDetach(work)
})
