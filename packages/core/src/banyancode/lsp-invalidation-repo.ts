export * as LspInvalidationRepo from "./lsp-invalidation-repo"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { LspInvalidationEventsTable } from "./lsp-invalidation-events.sql"

export type LspInvalidationKind = "file_changed" | "file_deleted" | "indexed" | "rebuilt"

export interface RecordEventInput {
  readonly kind: LspInvalidationKind
  readonly path: string
  readonly payload?: unknown
}

export interface InvalidationEvent {
  readonly id: number
  readonly kind: LspInvalidationKind
  readonly path: string
  readonly payload: unknown | null
  readonly createdAt: number
  readonly consumedAt: number | null
}

export interface ClaimUnconsumedInput {
  readonly limit?: number
}

export interface Interface {
  readonly recordEvent: (input: RecordEventInput) => Effect.Effect<{ id: number }, never, never>
  readonly claimUnconsumed: (input: ClaimUnconsumedInput) => Effect.Effect<ReadonlyArray<InvalidationEvent>, never, never>
  readonly markConsumed: (ids: ReadonlyArray<number>) => Effect.Effect<void, never, never>
  readonly listRecent: (limit: number) => Effect.Effect<ReadonlyArray<InvalidationEvent>, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/LspInvalidationRepo") {}

const mapRow = (row: typeof LspInvalidationEventsTable.$inferSelect): InvalidationEvent => ({
  id: row.id,
  kind: row.kind as LspInvalidationKind,
  path: row.path,
  payload: (row.payload as unknown | null) ?? null,
  createdAt: row.created_at,
  consumedAt: row.consumed_at,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const recordEvent: Interface["recordEvent"] = (input) =>
      Effect.gen(function* () {
        const now = Math.floor(Date.now() / 1000)
        // INSERT-only, no transaction needed: a single statement is atomic.
        const inserted = yield* db
          .insert(LspInvalidationEventsTable)
          .values({
            kind: input.kind,
            path: input.path,
            payload: input.payload === undefined ? null : (input.payload as never),
            created_at: now,
          })
          .returning({ id: LspInvalidationEventsTable.id })
          .get()
          .pipe(Effect.orDie)
        return { id: inserted.id }
      })

    const claimUnconsumed: Interface["claimUnconsumed"] = (input) =>
      Effect.gen(function* () {
        const limit = input.limit ?? 50
        if (limit <= 0) return []
        const rows = yield* db
          .select()
          .from(LspInvalidationEventsTable)
          .where(isNull(LspInvalidationEventsTable.consumed_at))
          .orderBy(asc(LspInvalidationEventsTable.id))
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapRow)
      })

    // `claimUnconsumed` is a non-mutating snapshot read; the row is marked
    // consumed only when the downstream consumer (LSPBridge) confirms the
    // event has been applied to LSP session state. Wrapping the UPDATE in a
    // transaction ensures the per-row state change is atomic with respect to
    // any concurrent consumer on the same DB. The `EffectSQLiteRunResult`
    // type does not expose a row count, so we return `void` and let the
    // caller treat the call as a fire-and-forget commit.
    const markConsumed: Interface["markConsumed"] = (ids) =>
      Effect.gen(function* () {
        if (ids.length === 0) return
        const now = Math.floor(Date.now() / 1000)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(LspInvalidationEventsTable)
                .set({ consumed_at: now })
                .where(
                  and(
                    inArray(LspInvalidationEventsTable.id, ids as number[]),
                    isNull(LspInvalidationEventsTable.consumed_at),
                  ),
                )
                .run()
            }),
          )
          .pipe(Effect.orDie)
      })

    const listRecent: Interface["listRecent"] = (limit) =>
      Effect.gen(function* () {
        if (limit <= 0) return []
        const rows = yield* db
          .select()
          .from(LspInvalidationEventsTable)
          .orderBy(sql`${LspInvalidationEventsTable.id} DESC`)
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapRow)
      })

    return Service.of({ recordEvent, claimUnconsumed, markConsumed, listRecent })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
