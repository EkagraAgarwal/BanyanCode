export * as SubagentMessagesRepo from "./subagent-messages-repo"

import { and, eq, isNotNull, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { SubagentMessagesTable } from "./subagent-messages.sql"
import type { SubagentMessage } from "./types"

export interface Interface {
  readonly put: (message: Omit<SubagentMessage, "deliveredAt"> & { deliveredAt?: number }) => Effect.Effect<void, never, never>
  readonly get: (id: string) => Effect.Effect<SubagentMessage | undefined, never, never>
  readonly listByParent: (parentSessionID: string, delivered: boolean) => Effect.Effect<SubagentMessage[], never, never>
  readonly markDelivered: (id: string, deliveredAt: number) => Effect.Effect<void, never, never>
  readonly listPending: (parentSessionID: string) => Effect.Effect<SubagentMessage[], never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/SubagentMessagesRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const put = Effect.fn("SubagentMessagesRepo.put")(function* (
      message: Omit<SubagentMessage, "deliveredAt"> & { deliveredAt?: number },
    ) {
      yield* db
        .insert(SubagentMessagesTable)
        .values({
          id: message.id,
          parent_session_id: message.parentSessionID,
          from_session: message.fromSession,
          from_agent: message.fromAgent,
          to_session: message.toSession,
          to_agent: message.toAgent,
          kind: message.kind,
          payload: message.payload,
          created_at: message.createdAt,
          delivered_at: message.deliveredAt,
        })
        .onConflictDoUpdate({
          target: SubagentMessagesTable.id,
          set: {
            parent_session_id: message.parentSessionID,
            from_session: message.fromSession,
            from_agent: message.fromAgent,
            to_session: message.toSession,
            to_agent: message.toAgent,
            kind: message.kind,
            payload: message.payload,
            created_at: message.createdAt,
            delivered_at: message.deliveredAt,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("SubagentMessagesRepo.get")(function* (id: string) {
      const row = yield* db
        .select()
        .from(SubagentMessagesTable)
        .where(eq(SubagentMessagesTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        parentSessionID: row.parent_session_id,
        fromSession: row.from_session,
        fromAgent: row.from_agent,
        toSession: row.to_session ?? undefined,
        toAgent: row.to_agent ?? undefined,
        kind: row.kind as SubagentMessage["kind"],
        payload: row.payload,
        deliveredAt: row.delivered_at ?? undefined,
        createdAt: row.created_at,
      }
    })

    const listByParent = Effect.fn("SubagentMessagesRepo.listByParent")(function* (
      parentSessionID: string,
      delivered: boolean,
    ) {
      const rows = yield* db
        .select()
        .from(SubagentMessagesTable)
        .where(
          delivered
            ? and(eq(SubagentMessagesTable.parent_session_id, parentSessionID), isNotNull(SubagentMessagesTable.delivered_at))
            : and(
                eq(SubagentMessagesTable.parent_session_id, parentSessionID),
                isNull(SubagentMessagesTable.delivered_at),
              ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        parentSessionID: row.parent_session_id,
        fromSession: row.from_session,
        fromAgent: row.from_agent,
        toSession: row.to_session ?? undefined,
        toAgent: row.to_agent ?? undefined,
        kind: row.kind as SubagentMessage["kind"],
        payload: row.payload,
        deliveredAt: row.delivered_at ?? undefined,
        createdAt: row.created_at,
      }))
    })

    const markDelivered = Effect.fn("SubagentMessagesRepo.markDelivered")(function* (id: string, deliveredAt: number) {
      yield* db
        .update(SubagentMessagesTable)
        .set({ delivered_at: deliveredAt })
        .where(eq(SubagentMessagesTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })

    const listPending = Effect.fn("SubagentMessagesRepo.listPending")(function* (parentSessionID: string) {
      const rows = yield* db
        .select()
        .from(SubagentMessagesTable)
        .where(
          and(
            eq(SubagentMessagesTable.parent_session_id, parentSessionID),
            isNull(SubagentMessagesTable.delivered_at),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        parentSessionID: row.parent_session_id,
        fromSession: row.from_session,
        fromAgent: row.from_agent,
        toSession: row.to_session ?? undefined,
        toAgent: row.to_agent ?? undefined,
        kind: row.kind as SubagentMessage["kind"],
        payload: row.payload,
        deliveredAt: row.delivered_at ?? undefined,
        createdAt: row.created_at,
      }))
    })

    return Service.of({ put, get, listByParent, markDelivered, listPending })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
