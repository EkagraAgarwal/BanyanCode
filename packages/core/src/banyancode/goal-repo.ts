export * as GoalRepo from "./goal-repo"

import { and, desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Ref } from "effect"
import { Database } from "../database/database"
import type { GoalReviewVerdict, GoalStatus } from "./goal-payload"
import { SubagentGoalsTable } from "./subagent-goals.sql"

export type { GoalReviewVerdict, GoalStatus } from "./goal-payload"

export type Goal = {
  id: string
  parentSessionID: string
  condition: string
  planPath: string | null
  priority: "low" | "normal" | "high" | null
  status: GoalStatus
  iterationCount: number
  lastReviewID: string | null
  lastReviewVerdict: GoalReviewVerdict | null
  lastReviewReason: string | null
  createdAt: number
  updatedAt: number
  achievedAt: number | null
  blockedAt: number | null
}

export type PutGoalInput = Omit<Goal, "iterationCount" | "updatedAt"> & {
  iterationCount?: number
  updatedAt?: number
}

export interface Interface {
  readonly put: (input: PutGoalInput) => Effect.Effect<void, never, never>
  readonly getByID: (id: string) => Effect.Effect<Goal | undefined, never, never>
  readonly getActiveForParent: (parentSessionID: string) => Effect.Effect<Goal | undefined, never, never>
  readonly listByParent: (parentSessionID: string) => Effect.Effect<Goal[], never, never>
  readonly listActive: () => Effect.Effect<Goal[], never, never>
  readonly markAchieved: (id: string, achievedAt?: number) => Effect.Effect<void, never, never>
  readonly markBlocked: (id: string, blockedAt?: number) => Effect.Effect<void, never, never>
  readonly markCancelled: (id: string) => Effect.Effect<void, never, never>
  readonly incrementIteration: (
    id: string,
    reviewID: string,
    verdict: GoalReviewVerdict,
    reason: string | null,
  ) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/GoalRepo") {}

export const mapGoalRowToGoal = (row: typeof SubagentGoalsTable.$inferSelect): Goal => ({
  id: row.id,
  parentSessionID: row.parent_session_id,
  condition: row.condition,
  planPath: row.plan_path,
  priority: row.priority as Goal["priority"],
  status: row.status as GoalStatus,
  iterationCount: row.iteration_count,
  lastReviewID: row.last_review_id,
  lastReviewVerdict: row.last_review_verdict as GoalReviewVerdict | null,
  lastReviewReason: row.last_review_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  achievedAt: row.achieved_at,
  blockedAt: row.blocked_at,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cache = yield* Ref.make<Record<string, Goal>>({})

    const put = Effect.fn("GoalRepo.put")(function* (input: PutGoalInput) {
      const now = Date.now()
      const iterationCount = input.iterationCount ?? 0
      const updatedAt = input.updatedAt ?? now
      yield* db
        .insert(SubagentGoalsTable)
        .values({
          id: input.id,
          parent_session_id: input.parentSessionID,
          condition: input.condition,
          plan_path: input.planPath,
          priority: input.priority,
          status: input.status,
          iteration_count: iterationCount,
          last_review_id: input.lastReviewID,
          last_review_verdict: input.lastReviewVerdict,
          last_review_reason: input.lastReviewReason,
          created_at: input.createdAt,
          updated_at: updatedAt,
          achieved_at: input.achievedAt,
          blocked_at: input.blockedAt,
        })
        .onConflictDoUpdate({
          target: SubagentGoalsTable.id,
          set: {
            parent_session_id: input.parentSessionID,
            condition: input.condition,
            plan_path: input.planPath,
            priority: input.priority,
            status: input.status,
            iteration_count: iterationCount,
            last_review_id: input.lastReviewID,
            last_review_verdict: input.lastReviewVerdict,
            last_review_reason: input.lastReviewReason,
            created_at: input.createdAt,
            updated_at: updatedAt,
            achieved_at: input.achievedAt,
            blocked_at: input.blockedAt,
          },
        })
        .run()
        .pipe(Effect.orDie)

      const goal: Goal = {
        id: input.id,
        parentSessionID: input.parentSessionID,
        condition: input.condition,
        planPath: input.planPath,
        priority: input.priority,
        status: input.status,
        iterationCount,
        lastReviewID: input.lastReviewID,
        lastReviewVerdict: input.lastReviewVerdict,
        lastReviewReason: input.lastReviewReason,
        createdAt: input.createdAt,
        updatedAt,
        achievedAt: input.achievedAt,
        blockedAt: input.blockedAt,
      }
      yield* Ref.update(cache, (current) => ({ ...current, [goal.id]: goal }))
    })

    const getByID = Effect.fn("GoalRepo.getByID")(function* (id: string) {
      const cached = (yield* Ref.get(cache))[id]
      // Active goals can be changed by GoalService transactions. Terminal rows
      // are immutable and therefore safe hot-cache hits.
      if (cached && cached.status !== "active") return cached

      const row = yield* db
        .select()
        .from(SubagentGoalsTable)
        .where(eq(SubagentGoalsTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const goal = mapGoalRowToGoal(row)
      yield* Ref.update(cache, (current) => ({ ...current, [goal.id]: goal }))
      return goal
    })

    const getActiveForParent = Effect.fn("GoalRepo.getActiveForParent")(function* (parentSessionID: string) {
      const row = yield* db
        .select()
        .from(SubagentGoalsTable)
        .where(
          and(
            eq(SubagentGoalsTable.parent_session_id, parentSessionID),
            eq(SubagentGoalsTable.status, "active"),
          ),
        )
        .orderBy(desc(SubagentGoalsTable.updated_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      const goal = mapGoalRowToGoal(row)
      yield* Ref.update(cache, (current) => ({ ...current, [goal.id]: goal }))
      return goal
    })

    const listByParent = Effect.fn("GoalRepo.listByParent")(function* (parentSessionID: string) {
      const rows = yield* db
        .select()
        .from(SubagentGoalsTable)
        .where(eq(SubagentGoalsTable.parent_session_id, parentSessionID))
        .orderBy(desc(SubagentGoalsTable.updated_at))
        .all()
        .pipe(Effect.orDie)
      const goals = rows.map(mapGoalRowToGoal)
      yield* Ref.update(cache, (current) => ({
        ...current,
        ...Object.fromEntries(goals.map((goal) => [goal.id, goal])),
      }))
      return goals
    })

    const listActive = Effect.fn("GoalRepo.listActive")(function* () {
      const rows = yield* db
        .select()
        .from(SubagentGoalsTable)
        .where(eq(SubagentGoalsTable.status, "active"))
        .orderBy(desc(SubagentGoalsTable.updated_at))
        .all()
        .pipe(Effect.orDie)
      const goals = rows.map(mapGoalRowToGoal)
      yield* Ref.update(cache, (current) => ({
        ...current,
        ...Object.fromEntries(goals.map((goal) => [goal.id, goal])),
      }))
      return goals
    })

    const markAchieved = Effect.fn("GoalRepo.markAchieved")(function* (id: string, achievedAt = Date.now()) {
      yield* db
        .update(SubagentGoalsTable)
        .set({ status: "achieved", achieved_at: achievedAt, updated_at: achievedAt })
        .where(eq(SubagentGoalsTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (current) => {
        const goal = current[id]
        if (!goal) return current
        return {
          ...current,
          [id]: { ...goal, status: "achieved" as const, achievedAt, updatedAt: achievedAt },
        }
      })
    })

    const markBlocked = Effect.fn("GoalRepo.markBlocked")(function* (id: string, blockedAt = Date.now()) {
      yield* db
        .update(SubagentGoalsTable)
        .set({ status: "blocked", blocked_at: blockedAt, updated_at: blockedAt })
        .where(eq(SubagentGoalsTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (current) => {
        const goal = current[id]
        if (!goal) return current
        return {
          ...current,
          [id]: { ...goal, status: "blocked" as const, blockedAt, updatedAt: blockedAt },
        }
      })
    })

    const markCancelled = Effect.fn("GoalRepo.markCancelled")(function* (id: string) {
      const now = Date.now()
      yield* db
        .update(SubagentGoalsTable)
        .set({ status: "cancelled", updated_at: now })
        .where(eq(SubagentGoalsTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (current) => {
        const goal = current[id]
        if (!goal) return current
        return { ...current, [id]: { ...goal, status: "cancelled" as const, updatedAt: now } }
      })
    })

    const incrementIteration = Effect.fn("GoalRepo.incrementIteration")(function* (
      id: string,
      reviewID: string,
      verdict: GoalReviewVerdict,
      reason: string | null,
    ) {
      const now = Date.now()
      yield* db
        .update(SubagentGoalsTable)
        .set({
          iteration_count: sql`${SubagentGoalsTable.iteration_count} + 1`,
          last_review_id: reviewID,
          last_review_verdict: verdict,
          last_review_reason: reason,
          updated_at: now,
        })
        .where(eq(SubagentGoalsTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (current) => {
        const goal = current[id]
        if (!goal) return current
        return {
          ...current,
          [id]: {
            ...goal,
            iterationCount: goal.iterationCount + 1,
            lastReviewID: reviewID,
            lastReviewVerdict: verdict,
            lastReviewReason: reason,
            updatedAt: now,
          },
        }
      })
    })

    return Service.of({
      put,
      getByID,
      getActiveForParent,
      listByParent,
      listActive,
      markAchieved,
      markBlocked,
      markCancelled,
      incrementIteration,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
