export * as SubagentReviewRequests from "./subagent-review-requests-repo"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Ref } from "effect"
import { Database } from "../database/database"
import { SubagentReviewRequestsTable } from "./subagent-review-requests.sql"

export type ReviewStatus = "pending" | "dispatched" | "completed" | "failed"

export interface SubagentReviewRequest {
  id: string
  parentSessionID: string
  targetAgent: string
  diff: string | null
  description: string | null
  paths: ReadonlyArray<string> | null
  priority: string | null
  reason: string | null
  status: ReviewStatus
  createdAt: number
  updatedAt: number
  result: unknown
}

export interface Interface {
  readonly put: (
    request: Omit<SubagentReviewRequest, "updatedAt"> & { updatedAt?: number },
  ) => Effect.Effect<void, never, never>
  readonly getByID: (id: string) => Effect.Effect<SubagentReviewRequest | undefined, never, never>
  readonly listByParent: (parentSessionID: string) => Effect.Effect<SubagentReviewRequest[], never, never>
  readonly markDispatched: (id: string) => Effect.Effect<void, never, never>
  readonly markCompleted: (input: { id: string; result: unknown }) => Effect.Effect<void, never, never>
  readonly markFailed: (input: { id: string; result: unknown }) => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SubagentReviewRequestsRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cache = yield* Ref.make<Record<string, SubagentReviewRequest>>({})

    const put = Effect.fn("SubagentReviewRequestsRepo.put")(function* (
      request: Omit<SubagentReviewRequest, "updatedAt"> & { updatedAt?: number },
    ) {
      const now = Date.now()
      yield* db
        .insert(SubagentReviewRequestsTable)
        .values({
          id: request.id,
          parent_session_id: request.parentSessionID,
          target_agent: request.targetAgent,
          diff: request.diff,
          description: request.description,
          paths: request.paths as string[] | null,
          priority: request.priority,
          reason: request.reason,
          status: request.status,
          created_at: request.createdAt,
          updated_at: request.updatedAt ?? now,
          result: request.result as unknown,
        })
        .onConflictDoUpdate({
          target: SubagentReviewRequestsTable.id,
          set: {
            parent_session_id: request.parentSessionID,
            target_agent: request.targetAgent,
            diff: request.diff,
            description: request.description,
            paths: request.paths as string[] | null,
            priority: request.priority,
            reason: request.reason,
            status: request.status,
            created_at: request.createdAt,
            updated_at: request.updatedAt ?? now,
            result: request.result as unknown,
          },
        })
        .run()
        .pipe(Effect.orDie)

      const stored: SubagentReviewRequest = {
        ...request,
        updatedAt: request.updatedAt ?? now,
      }
      yield* Ref.update(cache, (c) => ({ ...c, [request.id]: stored }))
    })

    const getByID = Effect.fn("SubagentReviewRequestsRepo.getByID")(function* (id: string) {
      const cached = yield* Ref.get(cache)
      if (cached[id]) return cached[id]

      const row = yield* db
        .select()
        .from(SubagentReviewRequestsTable)
        .where(eq(SubagentReviewRequestsTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        parentSessionID: row.parent_session_id,
        targetAgent: row.target_agent,
        diff: row.diff,
        description: row.description,
        paths: row.paths as ReadonlyArray<string> | null,
        priority: row.priority,
        reason: row.reason,
        status: row.status as ReviewStatus,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        result: row.result,
      }
    })

    const listByParent = Effect.fn("SubagentReviewRequestsRepo.listByParent")(function* (
      parentSessionID: string,
    ) {
      const rows = yield* db
        .select()
        .from(SubagentReviewRequestsTable)
        .where(eq(SubagentReviewRequestsTable.parent_session_id, parentSessionID))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        parentSessionID: row.parent_session_id,
        targetAgent: row.target_agent,
        diff: row.diff,
        description: row.description,
        paths: row.paths as ReadonlyArray<string> | null,
        priority: row.priority,
        reason: row.reason,
        status: row.status as ReviewStatus,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        result: row.result,
      }))
    })

    const markDispatched = Effect.fn("SubagentReviewRequestsRepo.markDispatched")(function* (id: string) {
      const now = Date.now()
      yield* db
        .update(SubagentReviewRequestsTable)
        .set({ status: "dispatched", updated_at: now })
        .where(eq(SubagentReviewRequestsTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (c) => {
        const row = c[id]
        if (!row) return c
        return { ...c, [id]: { ...row, status: "dispatched" as const, updatedAt: now } }
      })
    })

    const markCompleted = Effect.fn("SubagentReviewRequestsRepo.markCompleted")(function* (input: {
      id: string
      result: unknown
    }) {
      const now = Date.now()
      yield* db
        .update(SubagentReviewRequestsTable)
        .set({ status: "completed", updated_at: now, result: input.result as unknown })
        .where(eq(SubagentReviewRequestsTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (c) => {
        const row = c[input.id]
        if (!row) return c
        return { ...c, [input.id]: { ...row, status: "completed" as const, updatedAt: now, result: input.result } }
      })
    })

    const markFailed = Effect.fn("SubagentReviewRequestsRepo.markFailed")(function* (input: {
      id: string
      result: unknown
    }) {
      const now = Date.now()
      yield* db
        .update(SubagentReviewRequestsTable)
        .set({ status: "failed", updated_at: now, result: input.result as unknown })
        .where(eq(SubagentReviewRequestsTable.id, input.id))
        .run()
        .pipe(Effect.orDie)
      yield* Ref.update(cache, (c) => {
        const row = c[input.id]
        if (!row) return c
        return { ...c, [input.id]: { ...row, status: "failed" as const, updatedAt: now, result: input.result } }
      })
    })

    return Service.of({ put, getByID, listByParent, markDispatched, markCompleted, markFailed })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))