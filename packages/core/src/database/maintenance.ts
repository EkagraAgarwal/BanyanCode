export * as DatabaseMaintenance from "./maintenance"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { compactSnapshots, runStartupMaintenance } from "../event/compaction"
import type { CompactionReport, MaintenanceReport } from "../event/compaction"
import { applyCodeBackfills } from "./migration"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

// Single row in the `migration` journal; shared across processes that open the same DB file.
export const MARKER_ID = "maintenance:last_run"
export const INTERVAL_MS = 6 * 60 * 60 * 1000
export const INITIAL_DELAY_MS = 30 * 1000

export interface Report {
  readonly ran: boolean
  readonly compaction?: CompactionReport
  readonly vacuum?: MaintenanceReport
}

export function runEventCompaction(db: Database) {
  return compactSnapshots(db).pipe(
    Effect.tap((report) => Effect.logInfo("event log compaction complete", { ...report })),
  )
}

// Backfill, then event compaction, then bounded incremental_vacuum. Skips when another run (any
// process) finished less than INTERVAL_MS ago unless `force`. Never part of the open path.
export function run(db: Database, options?: { force?: boolean; now?: number }) {
  return Effect.gen(function* () {
    const now = options?.now ?? Date.now()
    if (!options?.force) {
      const marker = yield* db.get<{ time_completed: number }>(
        sql`SELECT time_completed FROM ${sql.identifier("migration")} WHERE id = ${MARKER_ID}`,
      )
      if (marker && now - marker.time_completed < INTERVAL_MS) return { ran: false } satisfies Report
    }
    yield* applyCodeBackfills(db)
    const compaction = yield* runEventCompaction(db)
    const vacuum = yield* runStartupMaintenance(db)
    yield* db.run(
      sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${MARKER_ID}, ${now}) ON CONFLICT(id) DO UPDATE SET time_completed = excluded.time_completed`,
    )
    return { ran: true, compaction, vacuum } satisfies Report
  })
}

// Long-lived loop for the app runtime. Failures are logged, never propagated.
export function loop(db: Database) {
  return Effect.gen(function* () {
    if (process.env.BANYANCODE_DB_MAINTENANCE === "0") return
    yield* Effect.sleep(INITIAL_DELAY_MS)
    if (process.env.BANYANCODE_DB_MAINTENANCE === "0") return
    yield* run(db).pipe(
      Effect.catchCause((cause) => Effect.logWarning("db maintenance failed", { cause: String(cause) })),
      Effect.andThen(Effect.sleep(INTERVAL_MS)),
      Effect.forever,
    )
  })
}
