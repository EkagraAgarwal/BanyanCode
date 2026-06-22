export * as SubagentConsumer from "./subagent-consumer"

import { Context, Effect, Layer, Queue, Scope } from "effect"
import { SubagentBus } from "./subagent-bus"
import { MemoryRepo } from "./memory-repo"
import { SubagentMessagesRepo } from "./subagent-messages-repo"
import type { PlanDefinition, SubagentMessage } from "./types"
import type { SessionSchema } from "../session/schema"

export interface Interface {
  readonly start: (
    input: {
      sessionID: SessionSchema.ID
      agent: string
      plan?: PlanDefinition
    },
    scope: Scope.Scope,
  ) => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SubagentConsumer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* SubagentBus.Service
    const memory = yield* MemoryRepo.Service
    const messages = yield* SubagentMessagesRepo.Service

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
              yield* messages.markDelivered(msg.id, Date.now())
              return
            }
            case "checkpoint":
            case "inform":
            case "answer":
            case "poll":
            case "request":
              break
          }
          yield* messages.markDelivered(msg.id, Date.now())
        }
      })

    const start: Interface["start"] = (input, scope) =>
      Effect.gen(function* () {
        const queue = yield* bus.subscribe(input.sessionID)
        yield* Effect.forkIn(loop(input, queue), scope)
      })

    return Service.of({ start })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SubagentBus.defaultLayer),
  Layer.provide(MemoryRepo.defaultLayer),
  Layer.provide(SubagentMessagesRepo.defaultLayer),
)