export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import { STRIP_PATCH_BODIES_BACKFILL_ID, stripSnapshotPatchBodies } from "../event/compaction"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      yield* applyOnly(db, migrations)
    }),
  )
}

// Code backfills share the `migration` journal with SQL migrations (same
// id/marker convention) but run outside a single wrapping transaction:
// each batch commits on its own, so a multi-GB rewrite never holds one
// giant journal. Entries are idempotent and safe to re-run; the marker is
// recorded only after the full pass completes, so an interrupted run
// resumes (re-scanning, skipping already-rewritten rows) on next open.
// Never run from `apply()` (a multi-GB rewrite must not block open): the background
// maintenance fiber and `banyancode db compact` call it. Not registered in migration.gen.ts: that registry is generated from
// drizzle SQL dirs, and a code-only entry would trip its --check.
export function applyCodeBackfills(db: Database) {
  return Effect.gen(function* () {
    const completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.has(STRIP_PATCH_BODIES_BACKFILL_ID)) return
    if (!process.env.OPENCODE_SKIP_MIGRATIONS) {
      const report = yield* stripSnapshotPatchBodies(db)
      yield* Effect.logInfo("strip snapshot patch bodies complete", { ...report })
    }
    yield* db.run(
      sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${STRIP_PATCH_BODIES_BACKFILL_ID}, ${Date.now()})`,
    )
  })
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          if (!process.env.OPENCODE_SKIP_MIGRATIONS) yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
