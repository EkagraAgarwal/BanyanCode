import { Effect, Option, Queue } from "effect"
import { Service as CodegraphEmbedServiceService, EmbedEvent as CodegraphEmbedServiceEmbedEvent } from "@opencode-ai/core/banyancode/codegraph-embed-service"
import { EventV2Bridge } from "@/event-v2-bridge"

export const applyCodegraphEmbedBridge = Effect.gen(function* () {
  const embedServiceOpt = yield* Effect.serviceOption(CodegraphEmbedServiceService)
  const eventsOpt = yield* Effect.serviceOption(EventV2Bridge.Service)
  if (Option.isNone(embedServiceOpt) || Option.isNone(eventsOpt)) return

  const embedService = embedServiceOpt.value
  const events = eventsOpt.value
  const queue = embedService.events()

  const work = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      yield* events.publish(CodegraphEmbedServiceEmbedEvent, event.properties)
    }
  })

  yield* Effect.forkIn(work, yield* Effect.scope)
})
