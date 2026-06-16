export * as MemoryRepo from "./memory-repo"

import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { CodegraphEmbeddingsTable } from "./codegraph.sql"
import { MemoryEntriesTable } from "./memory.sql"
import type { MemoryEntry } from "./types"

export interface Interface {
  readonly put: (entry: Omit<MemoryEntry, "createdAt"> & { createdAt?: number }) => Effect.Effect<void, never, never>
  readonly get: (id: string) => Effect.Effect<MemoryEntry | undefined, never, never>
  readonly list: (scope: "global" | "session", sessionID?: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly forget: (id: string) => Effect.Effect<void, never, never>
  readonly search: (scope: "global" | "session", sessionID: string | undefined, key: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly vacuum: () => Effect.Effect<number, never, never>
  readonly touch: (key: string, scope: "global" | "session", sessionID?: string) => Effect.Effect<void, never, never>
  readonly searchByEmbedding: (input: {
    queryEmbedding: Float32Array
    limit: number
    scope: "global" | "session"
    sessionID?: string
  }) => Effect.Effect<Array<{ entryID: string; similarity: number }>, never, never>
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
          updated_at: now,
          last_accessed_at: now,
          access_count: 0,
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
            updated_at: now,
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

    const touch = Effect.fn("MemoryRepo.touch")(function* (key: string, scope: "global" | "session", sessionID?: string) {
      const now = Date.now()
      yield* db
        .update(MemoryEntriesTable)
        .set({
          access_count: sql`${MemoryEntriesTable.access_count} + 1`,
          last_accessed_at: now,
        })
        .where(
          scope === "global"
            ? and(eq(MemoryEntriesTable.scope, "global"), eq(MemoryEntriesTable.key, key))
            : and(
                eq(MemoryEntriesTable.scope, "session"),
                eq(MemoryEntriesTable.session_id, sessionID ?? ""),
                eq(MemoryEntriesTable.key, key),
              ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const searchByEmbedding = Effect.fn("MemoryRepo.searchByEmbedding")(function* (input: {
      queryEmbedding: Float32Array
      limit: number
      scope: "global" | "session"
      sessionID?: string
    }) {
      const rows = yield* db
        .select({
          entryID: MemoryEntriesTable.id,
          embedding: CodegraphEmbeddingsTable.embedding,
        })
        .from(MemoryEntriesTable)
        .innerJoin(CodegraphEmbeddingsTable, eq(MemoryEntriesTable.embedding_id, CodegraphEmbeddingsTable.id))
        .where(
          input.scope === "global"
            ? eq(MemoryEntriesTable.scope, "global")
            : and(eq(MemoryEntriesTable.scope, "session"), eq(MemoryEntriesTable.session_id, input.sessionID ?? "")),
        )
        .all()
        .pipe(Effect.orDie)

      const scored = rows
        .map((row) => {
          if (!row.embedding) return { entryID: row.entryID, similarity: 0 }
          const nodeEmbedding = new Float32Array(new Uint8Array(row.embedding).buffer)
          return { entryID: row.entryID, similarity: cosineSimilarity(input.queryEmbedding, nodeEmbedding) }
        })
        .filter((s) => s.similarity > 0)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, input.limit)

      return scored
    })

    return Service.of({ put, get, list, forget, search, vacuum, touch, searchByEmbedding })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
