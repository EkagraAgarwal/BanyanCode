export * as MemoryRepo from "./memory-repo"

import { and, eq, isNotNull, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { MemoryEntriesTable } from "./memory.sql"
import type { MemoryEntry } from "./types"
import { NotFoundError, StaleWriteError } from "./types"

export interface PutInput {
  id: string
  key: string
  value: unknown
  context?: string
  tags?: string[]
  scope: "global" | "session"
  sessionID?: string
  expiresAt?: number
  agentID?: string
}

export interface UpdateInput {
  id: string
  expectedVersion: number
  value?: unknown
  agentID?: string
  context?: string
  tags?: string[]
}

export interface ForgetByKeyInput {
  key: string
  scope: "global" | "session"
  sessionID?: string
}

export interface Interface {
  readonly put: (input: PutInput & { createdAt?: number }) => Effect.Effect<void, never, never>
  readonly get: (id: string) => Effect.Effect<MemoryEntry | undefined, never, never>
  readonly list: (scope: "global" | "session", sessionID?: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly forget: (id: string) => Effect.Effect<void, never, never>
  readonly forgetByKey: (input: ForgetByKeyInput) => Effect.Effect<number, never, never>
  readonly search: (scope: "global" | "session", sessionID: string | undefined, key: string) => Effect.Effect<MemoryEntry[], never, never>
  readonly vacuum: () => Effect.Effect<number, never, never>
  readonly update: (input: UpdateInput) => Effect.Effect<MemoryEntry, NotFoundError | StaleWriteError, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryRepo") {}

const deriveNamespace = (key: string): string | null => {
  const colonIndex = key.indexOf(":")
  return colonIndex > 0 ? key.slice(0, colonIndex) : null
}

const mapRowToEntry = (row: typeof MemoryEntriesTable.$inferSelect): MemoryEntry => ({
  id: row.id,
  key: row.key,
  value: row.value,
  context: row.context ?? undefined,
  tags: row.tags,
  scope: row.scope as "global" | "session",
  sessionID: row.session_id ?? undefined,
  createdAt: row.created_at,
  expiresAt: row.expires_at ?? undefined,
  agentID: row.agent_id ?? undefined,
  version: row.version,
  updatedAt: row.updated_at,
  namespace: row.namespace ?? undefined,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const put = Effect.fn("MemoryRepo.put")(function* (input: PutInput & { createdAt?: number }) {
      const now = input.createdAt ?? Date.now()
      const namespace = deriveNamespace(input.key)

      yield* db
        .insert(MemoryEntriesTable)
        .values({
          id: input.id,
          key: input.key,
          value: input.value,
          context: input.context,
          tags: input.tags ?? [],
          scope: input.scope,
          session_id: input.sessionID,
          created_at: now,
          expires_at: input.expiresAt,
          agent_id: input.agentID,
          version: 1,
          updated_at: now,
          namespace,
        })
        .onConflictDoUpdate({
          target: MemoryEntriesTable.id,
          set: {
            key: input.key,
            value: input.value,
            context: input.context,
            tags: input.tags ?? [],
            scope: input.scope,
            session_id: input.sessionID,
            expires_at: input.expiresAt,
            agent_id: input.agentID,
            version: sql`${MemoryEntriesTable.version} + 1`,
            updated_at: now,
            namespace,
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
      return mapRowToEntry(row)
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
      return rows.map(mapRowToEntry)
    })

    const forget = Effect.fn("MemoryRepo.forget")(function* (id: string) {
      yield* db.delete(MemoryEntriesTable).where(eq(MemoryEntriesTable.id, id)).run().pipe(Effect.orDie)
    })

    const forgetByKey = Effect.fn("MemoryRepo.forgetByKey")(function* (input: ForgetByKeyInput) {
      const result = yield* db
        .delete(MemoryEntriesTable)
        .where(
          input.scope === "global"
            ? and(eq(MemoryEntriesTable.scope, "global"), eq(MemoryEntriesTable.key, input.key))
            : and(
                eq(MemoryEntriesTable.scope, "session"),
                eq(MemoryEntriesTable.session_id, input.sessionID ?? ""),
                eq(MemoryEntriesTable.key, input.key),
              ),
        )
        .returning()
        .run()
        .pipe(Effect.orDie)
      return result.length
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
      return rows.map(mapRowToEntry)
    })

    const update: Interface["update"] = (input) => {
      return db.transaction((tx) =>
        Effect.gen(function* () {
          const now = Date.now()

          // First, get the current row to check its version
          const currentRow = yield* tx
            .select()
            .from(MemoryEntriesTable)
            .where(eq(MemoryEntriesTable.id, input.id))
            .get()
            .pipe(Effect.orDie)

          if (!currentRow) {
            return yield* Effect.fail(new NotFoundError({ id: input.id }))
          }

          if (currentRow.version !== input.expectedVersion) {
            return yield* Effect.fail(new StaleWriteError({
              id: input.id,
              expectedVersion: input.expectedVersion,
              currentVersion: currentRow.version,
            }))
          }

          // Perform the update
          yield* tx
            .update(MemoryEntriesTable)
            .set({
              value: input.value ?? currentRow.value,
              context: input.context ?? currentRow.context,
              tags: input.tags ?? currentRow.tags,
              version: currentRow.version + 1,
              updated_at: now,
              agent_id: input.agentID ?? currentRow.agent_id,
            })
            .where(and(eq(MemoryEntriesTable.id, input.id), eq(MemoryEntriesTable.version, input.expectedVersion)))
            .run()
            .pipe(Effect.orDie)

          // Fetch and return the updated row
          const updatedRow = yield* tx
            .select()
            .from(MemoryEntriesTable)
            .where(eq(MemoryEntriesTable.id, input.id))
            .get()
            .pipe(Effect.orDie)

          return mapRowToEntry(updatedRow!)
        })
      ).pipe(
        Effect.catchIf(
          (err): err is any => (err as any)._tag === "SqlError",
          (err) => Effect.die(err)
        )
      )
    }

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

    return Service.of({ put, get, list, forget, forgetByKey, search, vacuum, update })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))