import { Effect, Queue } from "effect"
import { Service as CodegraphBuildServiceService, BuildEvent as CodegraphBuildServiceBuildEvent } from "@opencode-ai/core/banyancode/codegraph-build-service"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

export const applyCodegraphBuildBridge = Effect.gen(function* () {
  const flags = yield* RuntimeFlags.Service
  if (!flags.banyancodeEnable) return

  const buildService = yield* CodegraphBuildServiceService
  const events = yield* EventV2Bridge.Service

  const queue = buildService.events()

  const work = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue)
      yield* events.publish(CodegraphBuildServiceBuildEvent, event.properties)
    }
  })

  yield* Effect.forkIn(work, yield* Effect.scope)
})
