import { Effect, Option, Queue } from "effect"
import { Service as CodegraphBuildServiceService, BuildEvent as CodegraphBuildServiceBuildEvent } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { EventV2Bridge } from "@/event-v2-bridge"

export const applyCodegraphBuildBridge = Effect.gen(function* () {
  const buildServiceOpt = yield* Effect.serviceOption(CodegraphBuildServiceService)
  const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)
  if (Option.isNone(buildServiceOpt) || Option.isNone(eventsOpt)) return

  const buildService = buildServiceOpt.value
  const events = eventsOpt.value
  const queue = buildService.events()

  const work = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      yield* events.publish(CodegraphBuildServiceBuildEvent, event.properties)
    }
  })

  // Detach from the caller scope so the drain fiber survives the bridge's
  // calling context. Same reason as codegraph-build-service.start(): forkIn
  // would require Scope in context, which is not available here.
  yield* Effect.forkDetach(work)
})
