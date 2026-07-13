export * as SubagentConsumer from "./subagent-consumer"

import { Context, Effect, Fiber, Layer, Queue } from "effect"
import { SubagentBus } from "./subagent-bus"
import { MemoryRepo } from "./memory-repo"
import { SubagentMessagesRepo } from "./subagent-messages-repo"
import { MeshCoordinator } from "./mesh-coordinator"
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
    const messages = yield* SubagentMessagesRepo.Service
    const mesh = yield* MeshCoordinator.Service

    const loop = (
      input: { sessionID: SessionSchema.ID; agent: string; plan?: PlanDefinition },
      queue: Queue.Dequeue<SubagentMessage>,
    ) =>
      Effect.gen(function* () {
        try {
          while (true) {
            const msg = yield* Queue.take(queue)
            switch (msg.kind) {
              case "plan": {
                // Phase 1a idempotency fix: reuse msg.id as the memory entry
                // id. The `memory_entries.id` primary key + the put
                // onConflictDoUpdate path make the second redelivery a
                // version bump (no duplicate row) instead of a fresh insert.
                yield* memory.put({
                  id: msg.id,
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
                yield* mesh.unregisterConsumer(input.sessionID, input.agent)
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
        } finally {
          yield* mesh.unregisterConsumer(input.sessionID, input.agent)
        }
      })

    // forkDetach (not forkIn): the consumer must survive the spawning request
    // scope. Per AGENTS.md, `forkIn(scope)` requires Scope in the fiber's
    // CONTEXT which a long-lived background consumer doesn't carry, and ties
    // the fiber lifetime to scope — when the orchestrator's HTTP request
    // returns the fiber is interrupted and peer messages pile up undelivered.
    const start: Interface["start"] = (input) =>
      Effect.gen(function* () {
        const queue = yield* bus.subscribe(input.sessionID)
        const fiber = yield* Effect.forkDetach(loop(input, queue))
        yield* mesh.registerConsumer(input.sessionID, input.agent, fiber)
      })

    return Service.of({ start })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SubagentBus.defaultLayer),
  Layer.provide(MemoryRepo.defaultLayer),
  Layer.provide(SubagentMessagesRepo.defaultLayer),
  Layer.provide(MeshCoordinator.defaultLayer),
)
