export * as GoalService from "./goal-service"

import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Queue, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "../database/database"
import type { GoalReviewVerdict, GoalStatus } from "./goal-payload"
import { GoalRepo, mapGoalRowToGoal, type Goal } from "./goal-repo"
import { SubagentGoalsTable } from "./subagent-goals.sql"

export interface SetGoalInput {
  id?: string
  parentSessionID: string
  condition: string
  planPath?: string | null
  priority?: "low" | "normal" | "high" | null
}

export type GoalEventEnvelope = {
  type:
    | "banyancode.goal.set"
    | "banyancode.goal.review_recorded"
    | "banyancode.goal.achieved"
    | "banyancode.goal.blocked"
    | "banyancode.goal.cancelled"
  properties: Record<string, unknown>
}

export class GoalConflictError extends Schema.TaggedErrorClass<GoalConflictError>()("Banyan/GoalConflictError", {
  parentSessionID: Schema.String,
  existingGoalID: Schema.String,
}) {}

export interface Interface {
  readonly setGoal: (input: SetGoalInput) => Effect.Effect<Goal, GoalConflictError, never>
  readonly getGoal: (id: string) => Effect.Effect<Goal | undefined, never, never>
  readonly getActiveGoal: (parentSessionID: string) => Effect.Effect<Goal | undefined, never, never>
  readonly listGoals: (parentSessionID: string) => Effect.Effect<Goal[], never, never>
  readonly recordReviewVerdict: (input: {
    id: string
    reviewID: string
    verdict: GoalReviewVerdict
    reason: string | null
  }) => Effect.Effect<Goal, never, never>
  readonly achieve: (id: string, reason?: string) => Effect.Effect<Goal, never, never>
  readonly block: (id: string, reason: string) => Effect.Effect<Goal, never, never>
  readonly cancel: (id: string, reason?: string) => Effect.Effect<Goal, never, never>
  /** Bounded events queue; the opencode-side bridge drains it. Do not consume internally. */
  readonly events: () => Queue.Dequeue<GoalEventEnvelope>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/GoalService") {}

export const layer: Layer.Layer<Service, never, GoalRepo.Service | Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* GoalRepo.Service
    const { db } = yield* Database.Service
    const events = yield* Queue.bounded<GoalEventEnvelope>(64).pipe(Effect.orDie)
    yield* Effect.addFinalizer(() => Queue.shutdown(events))

    const publish = (envelope: GoalEventEnvelope) => Queue.offer(events, envelope).pipe(Effect.ignore)

    // This queue is drained only by the opencode-side goal bridge. Adding an
    // internal consumer would race the bridge because Effect queues are
    // single-consumer.

    const setGoal = Effect.fn("GoalService.setGoal")(function* (input: SetGoalInput) {
      const id = input.id ?? randomUUID()
      const now = Date.now()
      const goal = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select()
              .from(SubagentGoalsTable)
              .where(
                and(
                  eq(SubagentGoalsTable.parent_session_id, input.parentSessionID),
                  eq(SubagentGoalsTable.status, "active"),
                ),
              )
              .orderBy(desc(SubagentGoalsTable.updated_at))
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (existing) {
              return yield* new GoalConflictError({
                parentSessionID: input.parentSessionID,
                existingGoalID: existing.id,
              })
            }

            const existingID = yield* tx
              .select({ id: SubagentGoalsTable.id })
              .from(SubagentGoalsTable)
              .where(eq(SubagentGoalsTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (existingID) {
              return yield* new GoalConflictError({
                parentSessionID: input.parentSessionID,
                existingGoalID: existingID.id,
              })
            }

            yield* tx
              .insert(SubagentGoalsTable)
              .values({
                id,
                parent_session_id: input.parentSessionID,
                condition: input.condition,
                plan_path: input.planPath ?? null,
                priority: input.priority ?? null,
                status: "active",
                iteration_count: 0,
                last_review_id: null,
                last_review_verdict: null,
                last_review_reason: null,
                created_at: now,
                updated_at: now,
                achieved_at: null,
                blocked_at: null,
              })
              .run()
              .pipe(Effect.orDie)

            const row = yield* tx
              .select()
              .from(SubagentGoalsTable)
              .where(eq(SubagentGoalsTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* Effect.die(`GoalService.setGoal: inserted goal ${id} was not found`)
            return mapGoalRowToGoal(row)
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))

      yield* publish({
        type: "banyancode.goal.set",
        properties: {
          id: goal.id,
          parentSessionID: goal.parentSessionID,
          condition: goal.condition,
          planPath: goal.planPath,
          priority: goal.priority,
        },
      })
      return goal
    })

    const getGoal = Effect.fn("GoalService.getGoal")(function* (id: string) {
      return yield* repo.getByID(id)
    })

    const getActiveGoal = Effect.fn("GoalService.getActiveGoal")(function* (parentSessionID: string) {
      return yield* repo.getActiveForParent(parentSessionID)
    })

    const listGoals = Effect.fn("GoalService.listGoals")(function* (parentSessionID: string) {
      return yield* repo.listByParent(parentSessionID)
    })

    const recordReviewVerdict = Effect.fn("GoalService.recordReviewVerdict")(function* (input: {
      id: string
      reviewID: string
      verdict: GoalReviewVerdict
      reason: string | null
    }) {
      yield* repo.incrementIteration(input.id, input.reviewID, input.verdict, input.reason)
      const goal = yield* repo.getByID(input.id)
      if (!goal) return yield* Effect.die(`GoalService.recordReviewVerdict: goal ${input.id} was not found`)
      yield* publish({
        type: "banyancode.goal.review_recorded",
        properties: {
          id: goal.id,
          reviewID: input.reviewID,
          verdict: input.verdict,
          reason: input.reason,
          iterationCount: goal.iterationCount,
        },
      })
      return goal
    })

    const transitionActiveGoal = Effect.fn("GoalService.transitionActiveGoal")(function* (
      id: string,
      status: Exclude<GoalStatus, "active">,
      at: number,
    ) {
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(SubagentGoalsTable)
              .where(eq(SubagentGoalsTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!current) return undefined
            if (current.status !== "active") {
              return { goal: mapGoalRowToGoal(current), changed: false as const }
            }

            yield* tx
              .update(SubagentGoalsTable)
              .set(
                status === "achieved"
                  ? { status, updated_at: at, achieved_at: at }
                  : status === "blocked"
                    ? { status, updated_at: at, blocked_at: at }
                    : { status, updated_at: at },
              )
              .where(and(eq(SubagentGoalsTable.id, id), eq(SubagentGoalsTable.status, "active")))
              .run()
              .pipe(Effect.orDie)

            const updated = yield* tx
              .select()
              .from(SubagentGoalsTable)
              .where(eq(SubagentGoalsTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (!updated) return yield* Effect.die(`GoalService.transitionActiveGoal: goal ${id} disappeared`)
            return { goal: mapGoalRowToGoal(updated), changed: true as const }
          }),
        )
        .pipe(Effect.orDie)

      if (!result) return yield* Effect.die(`GoalService.transitionActiveGoal: goal ${id} was not found`)
      if (!result.changed) return result
      const refreshed = yield* repo.getByID(id)
      return { goal: refreshed ?? result.goal, changed: true as const }
    })

    const achieve = Effect.fn("GoalService.achieve")(function* (id: string, reason?: string) {
      const result = yield* transitionActiveGoal(id, "achieved", Date.now())
      if (result.changed) {
        yield* publish({
          type: "banyancode.goal.achieved",
          properties: {
            id: result.goal.id,
            parentSessionID: result.goal.parentSessionID,
            achievedAt: result.goal.achievedAt,
            ...(reason !== undefined ? { reason } : {}),
          },
        })
      }
      return result.goal
    })

    const block = Effect.fn("GoalService.block")(function* (id: string, reason: string) {
      const result = yield* transitionActiveGoal(id, "blocked", Date.now())
      if (result.changed) {
        yield* publish({
          type: "banyancode.goal.blocked",
          properties: {
            id: result.goal.id,
            parentSessionID: result.goal.parentSessionID,
            blockedAt: result.goal.blockedAt,
            reason,
          },
        })
      }
      return result.goal
    })

    const cancel = Effect.fn("GoalService.cancel")(function* (id: string, reason?: string) {
      const result = yield* transitionActiveGoal(id, "cancelled", Date.now())
      if (result.changed) {
        yield* publish({
          type: "banyancode.goal.cancelled",
          properties: {
            id: result.goal.id,
            parentSessionID: result.goal.parentSessionID,
            ...(reason !== undefined ? { reason } : {}),
          },
        })
      }
      return result.goal
    })

    const eventsDequeue: Interface["events"] = () => events

    return Service.of({
      setGoal,
      getGoal,
      getActiveGoal,
      listGoals,
      recordReviewVerdict,
      achieve,
      block,
      cancel,
      events: eventsDequeue,
    })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(GoalRepo.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
