export * as SubagentConsumer from "./subagent-consumer"

import { Context, Effect, Fiber, Layer, Option, Queue } from "effect"
import { SubagentBus } from "./subagent-bus"
import { MemoryRepo } from "./memory-repo"
import { SubagentMessagesRepo } from "./subagent-messages-repo"
import { MeshCoordinator } from "./mesh-coordinator"
import { SubagentPlans } from "./subagent-plans-repo"
import type { PlanDefinition, PlanStepStatusUpdate, SubagentMessage } from "./types"
import type { SessionSchema } from "../session/schema"

export interface Interface {
  readonly start: (input: {
    sessionID: SessionSchema.ID
    agent: string
    plan?: PlanDefinition
  }) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SubagentConsumer") {}

/**
 * Phase 1A G3: defensive reader for a `kind: "plan_update"` payload. The
 * SubagentBus carries `payload: unknown`, so we cannot trust the shape on
 * inbound. Returns `undefined` for any malformed input; the consumer logs
 * a warning and marks the message delivered without retrying (per the
 * "unknown planID" path) so the consumer keeps draining the queue.
 */
const readPlanStepStatusUpdate = (payload: unknown): PlanStepStatusUpdate | undefined => {
  if (!payload || typeof payload !== "object") return undefined
  const p = payload as Record<string, unknown>
  if (typeof p.planID !== "string" || p.planID.length === 0) return undefined
  if (typeof p.stepIndex !== "number" || !Number.isInteger(p.stepIndex) || p.stepIndex < 0) return undefined
  if (
    p.status !== "pending" &&
    p.status !== "in_progress" &&
    p.status !== "completed" &&
    p.status !== "cancelled"
  ) {
    return undefined
  }
  return { planID: p.planID, stepIndex: p.stepIndex, status: p.status }
}

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
        // Phase 1A G3: SubagentPlans is optional. The consumer only requires
        // it for `kind: "plan_update"` handling. The check happens here
        // (per message) so the runtime context of the consumer fiber — which
        // inherits the parent scope's services — can be inspected. If the
        // SubagentPlans layer is absent, plan_update messages log a warning
        // and fall through to `markDelivered` without retrying. This keeps
        // the consumer's `start` interface contract at
        // `Effect<void, never, never>` regardless of whether the host wires
        // up SubagentPlans. Mirrors the
        // `Effect.serviceOption(BanyanConfigService)` pattern in
        // AGENTS.md and the `Effect.serviceOption(MaxSubagents.Service)`
        // pattern in mesh-coordinator.ts.
        const plansOption = yield* Effect.serviceOption(SubagentPlans.Service)
        try {
          while (true) {
            const msg = yield* Queue.take(queue)
            switch (msg.kind) {
              case "plan": {
                // Phase 1a idempotency fix: reuse msg.id as the memory entry
                // id. The `memory_entries.id` primary key + the put
                // onConflictDoUpdate path make the second redelivery a
                // version bump (no duplicate row) instead of a fresh insert.
                // Phase 1A envelope note: publishers now wrap the
                // PlanDefinition with `{ planID, ...plan }` so planID is
                // discoverable on the memory entry. Downstream readers that
                // expect strict PlanDefinition should read `entry.value.plan`
                // or the top-level `entry.value.planID` as needed.
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
              case "plan_update": {
                // Phase 1A G3: apply the step status update to the persisted
                // SubagentPlans row. The repo is authoritative for the
                // `setStepStatus(planID, stepIndex, status)` contract —
                // unknown planIDs return `undefined` (no-op), out-of-bounds
                // stepIndex returns the plan unchanged. Either way, do not
                // retry: `markDelivered` below records the message as
                // processed and the consumer continues draining.
                if (Option.isNone(plansOption)) {
                  yield* Effect.logWarning(
                    `subagent-consumer: dropping plan_update because SubagentPlans layer is not in scope (msg.id=${msg.id})`,
                  )
                  break
                }
                const update = readPlanStepStatusUpdate(msg.payload)
                if (!update) {
                  yield* Effect.logWarning(
                    `subagent-consumer: dropping malformed plan_update (msg.id=${msg.id})`,
                  )
                  break
                }
                const plans = plansOption.value
                const result = yield* plans.setStepStatus(update.planID, update.stepIndex, update.status)
                if (!result) {
                  yield* Effect.logWarning(
                    `subagent-consumer: plan_update for unknown planID=${update.planID} (msg.id=${msg.id})`,
                  )
                }
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
  Layer.provide(SubagentPlans.defaultLayer),
)
