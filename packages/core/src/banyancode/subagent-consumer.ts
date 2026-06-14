export * as SubagentConsumer from "./subagent-consumer"

import { Context, Effect, Layer, Queue } from "effect"
import { SubagentBus } from "./subagent-bus"
import { MemoryRepo } from "./memory-repo"
import type { PlanDefinition, SubagentMessage } from "./types"
import type { SessionSchema } from "../session/schema"

export interface Interface {
  readonly start: (input: {
    sessionID: SessionSchema.ID
    agent: string
    plan?: PlanDefinition
  }) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SubagentConsumer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* SubagentBus.Service
    const memory = yield* MemoryRepo.Service

    const loop = (input: { sessionID: SessionSchema.ID; agent: string; plan?: PlanDefinition }, queue: Queue.Dequeue<SubagentMessage>) =>
      Effect.gen(function* () {
        while (true) {
          const msg = yield* Queue.take(queue)
          switch (msg.kind) {
            case "plan": {
              yield* memory.put({
                id: crypto.randomUUID(),
                key: `plan:${input.agent}`,
                value: msg.payload,
                tags: [],
                scope: "session",
                sessionID: input.sessionID,
                createdAt: Date.now(),
              })
              break
            }
            case "steer": {
              break
            }
            case "kill": {
              return
            }
            case "checkpoint":
            case "inform":
            case "answer":
            case "poll":
            case "request":
              break
          }
        }
      })

    const start: Interface["start"] = (input) => Effect.void

    return Service.of({ start })
  }),
)

export const defaultLayer = layer