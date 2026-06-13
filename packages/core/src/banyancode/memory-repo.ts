export * as MemoryRepo from "./memory-repo"

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { MemoryEntriesTable } from "./memory.sql"
import type { MemoryEntry } from "./types"

export interface Interface {
  readonly put: (entry: Omit<MemoryEntry, "createdAt"> & { createdAt?: number }) => Effect.Effect<void, never, never>
  readonly get: (id: string) => Effect.Effect<MemoryEntry | undefined, never, never>
  readonly list: (scope: "global" | "session", sessionID?: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly forget: (id: string) => Effect.Effect<void, never, never>
  readonly search: (scope: "global" | "session", sessionID: string | undefined, key: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly vacuum: () => Effect.Effect<number, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const put = Effect.fn("MemoryRepo.put")(function* (entry: Omit<MemoryEntry, "createdAt"> & { createdAt?: number }) {
      const now = entry.createdAt ?? Date.now()
      yield* db
        .insert(MemoryEntriesTable)
        .values({
          id: entry.id,
          key: entry.key,
          value: entry.value,
          context: entry.context,
          tags: entry.tags,
          scope: entry.scope,
          session_id: entry.sessionID,
          created_at: now,
          expires_at: entry.expiresAt,
        })
        .onConflictDoUpdate({
          target: MemoryEntriesTable.id,
          set: {
            key: entry.key,
            value: entry.value,
            context: entry.context,
            tags: entry.tags,
            scope: entry.scope,
            session_id: entry.sessionID,
            created_at: now,
            expires_at: entry.expiresAt,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("MemoryRepo.get")(function* (id: string) {
      const row = yield* db
        .select()
        .from(MemoryEntriesTable)
        .where(eq(MemoryEntriesTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return {
        id: row.id,
        key: row.key,
        value: row.value,
        context: row.context ?? undefined,
        tags: row.tags,
        scope: row.scope as "global" | "session",
        sessionID: row.session_id ?? undefined,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
      }
    })

    const list = Effect.fn("MemoryRepo.list")(function* (scope: "global" | "session", sessionID?: string) {
      const rows = yield* db
        .select()
        .from(MemoryEntriesTable)
        .where(
          scope === "global"
            ? eq(MemoryEntriesTable.scope, "global")
            : and(eq(MemoryEntriesTable.scope, "session"), eq(MemoryEntriesTable.session_id, sessionID ?? "")),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        key: row.key,
        value: row.value,
        context: row.context ?? undefined,
        tags: row.tags,
        scope: row.scope as "global" | "session",
        sessionID: row.session_id ?? undefined,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
      }))
    })

    const forget = Effect.fn("MemoryRepo.forget")(function* (id: string) {
      yield* db.delete(MemoryEntriesTable).where(eq(MemoryEntriesTable.id, id)).run().pipe(Effect.orDie)
    })

    const search = Effect.fn("MemoryRepo.search")(function* (
      scope: "global" | "session",
      sessionID: string | undefined,
      key: string,
    ) {
      const rows = yield* db
        .select()
        .from(MemoryEntriesTable)
        .where(
          scope === "global"
            ? and(eq(MemoryEntriesTable.scope, "global"), eq(MemoryEntriesTable.key, key))
            : and(
                eq(MemoryEntriesTable.scope, "session"),
                eq(MemoryEntriesTable.session_id, sessionID ?? ""),
                eq(MemoryEntriesTable.key, key),
              ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        key: row.key,
        value: row.value,
        context: row.context ?? undefined,
        tags: row.tags,
        scope: row.scope as "global" | "session",
        sessionID: row.session_id ?? undefined,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
      }))
    })

    const vacuum = Effect.fn("MemoryRepo.vacuum")(function* () {
      const now = Date.now()
      const result = yield* db
        .delete(MemoryEntriesTable)
        .where(and(isNotNull(MemoryEntriesTable.expires_at), lt(MemoryEntriesTable.expires_at, now)))
        .returning()
        .run()
        .pipe(Effect.orDie)
      return result.length
    })

    return Service.of({ put, get, list, forget, search, vacuum })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
