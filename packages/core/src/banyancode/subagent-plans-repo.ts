export * as SubagentPlans from "./subagent-plans-repo"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Ref } from "effect"
import { Database } from "../database/database"
import { SubagentPlansTable } from "./subagent-plans.sql"

export interface PlanStep {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

export interface SubagentPlan {
  id: string
  parentSessionID: string
  agent: string
  sessionID: string
  title: string
  steps: PlanStep[]
  exitCriteria: string
  status: "active" | "completed" | "cancelled"
  createdAt: number
  updatedAt: number
}

export interface Interface {
  readonly put: (plan: Omit<SubagentPlan, "updatedAt"> & { updatedAt?: number }) => Effect.Effect<void, never, never>
  readonly getByID: (id: string) => Effect.Effect<SubagentPlan | undefined, never, never>
  readonly listByParent: (parentSessionID: string) => Effect.Effect<SubagentPlan[], never, never>
  readonly listBySession: (sessionID: string) => Effect.Effect<SubagentPlan[], never, never>
  readonly markCompleted: (id: string) => Effect.Effect<void, never, never>
  readonly markCancelled: (id: string) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/SubagentPlansRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cache = yield* Ref.make<Record<string, SubagentPlan>>({})

    const put = Effect.fn("SubagentPlansRepo.put")(function* (
      plan: Omit<SubagentPlan, "updatedAt"> & { updatedAt?: number },
    ) {
      const now = Date.now()
      yield* db
        .insert(SubagentPlansTable)
        .values({
          id: plan.id,
          parent_session_id: plan.parentSessionID,
          agent: plan.agent,
          session_id: plan.sessionID,
          title: plan.title,
          steps: plan.steps,
          exit_criteria: plan.exitCriteria,
          status: plan.status,
          created_at: plan.createdAt,
          updated_at: plan.updatedAt ?? now,
        })
        .onConflictDoUpdate({
          target: SubagentPlansTable.id,
          set: {
            parent_session_id: plan.parentSessionID,
            agent: plan.agent,
            session_id: plan.sessionID,
            title: plan.title,
            steps: plan.steps,
            exit_criteria: plan.exitCriteria,
            status: plan.status,
            created_at: plan.createdAt,
            updated_at: plan.updatedAt ?? now,
          },
        })
        .run()
        .pipe(Effect.orDie)

      const updatedPlan: SubagentPlan = {
        ...plan,
        updatedAt: plan.updatedAt ?? now,
      }
      yield* Ref.update(cache, (c) => ({ ...c, [plan.id]: updatedPlan }))
    })

    const getByID = Effect.fn("SubagentPlansRepo.getByID")(function* (id: string) {
      const cached = yield* Ref.get(cache)
      if (cached[id]) return cached[id]

      const row = yield* db
        .select()
        .from(SubagentPlansTable)
        .where(eq(SubagentPlansTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        parentSessionID: row.parent_session_id,
        agent: row.agent,
        sessionID: row.session_id,
        title: row.title,
        steps: row.steps as PlanStep[],
        exitCriteria: row.exit_criteria,
        status: row.status as SubagentPlan["status"],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })

    const listByParent = Effect.fn("SubagentPlansRepo.listByParent")(function* (parentSessionID: string) {
      const rows = yield* db
        .select()
        .from(SubagentPlansTable)
        .where(eq(SubagentPlansTable.parent_session_id, parentSessionID))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        parentSessionID: row.parent_session_id,
        agent: row.agent,
        sessionID: row.session_id,
        title: row.title,
        steps: row.steps as PlanStep[],
        exitCriteria: row.exit_criteria,
        status: row.status as SubagentPlan["status"],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    })

    const listBySession = Effect.fn("SubagentPlansRepo.listBySession")(function* (sessionID: string) {
      const rows = yield* db
        .select()
        .from(SubagentPlansTable)
        .where(eq(SubagentPlansTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        parentSessionID: row.parent_session_id,
        agent: row.agent,
        sessionID: row.session_id,
        title: row.title,
        steps: row.steps as PlanStep[],
        exitCriteria: row.exit_criteria,
        status: row.status as SubagentPlan["status"],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    })

    const markCompleted = Effect.fn("SubagentPlansRepo.markCompleted")(function* (id: string) {
      const now = Date.now()
      yield* db
        .update(SubagentPlansTable)
        .set({ status: "completed", updated_at: now })
        .where(eq(SubagentPlansTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (c) => {
        const plan = c[id]
        if (!plan) return c
        return { ...c, [id]: { ...plan, status: "completed" as const, updatedAt: now } }
      })
    })

    const markCancelled = Effect.fn("SubagentPlansRepo.markCancelled")(function* (id: string) {
      const now = Date.now()
      yield* db
        .update(SubagentPlansTable)
        .set({ status: "cancelled", updated_at: now })
        .where(eq(SubagentPlansTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (c) => {
        const plan = c[id]
        if (!plan) return c
        return { ...c, [id]: { ...plan, status: "cancelled" as const, updatedAt: now } }
      })
    })

    return Service.of({ put, getByID, listByParent, listBySession, markCompleted, markCancelled })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
