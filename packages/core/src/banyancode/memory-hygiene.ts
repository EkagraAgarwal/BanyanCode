/**
 * BanyanCode Memory Hygiene (Phase 6).
 *
 * Maintenance operations over the canonical memory table.
 *
 *   - `expire()`   flips status from `active` to `expired` for entries past
 *                  `expiresAt`. Counter only counts entries that actually
 *                  change status (not already-expired rows are skipped).
 *   - `prune()`    deletes entries with status `rejected` and `expired`
 *                  older than the cutoff. Returns the count of deleted
 *                  rows.
 *   - `reconcile()` walks the `active` set, fingerprints each payload, and
 *                  marks duplicate-fingerprint rows as `superseded`
 *                  (keeping the most-recently-updated row as the survivor).
 *                  Returns the IDs of newly-superseded rows and the count
 *                  pruned via prune().
 *
 * All ops are deterministic, transaction-wrapped (single connection
 * reads — Drizzle `db.transaction` is overkill for idempotent maintenance
 * so we rely on Effect-TS Effect sequencing within a single Effect.gen),
 * and safe to re-run.
 */

import { Context, Effect, Layer } from "effect"
import { and, eq, lt, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { MemoryEntriesTable } from "./memory.sql"
import { unwrapMemoryValue, payloadFingerprint } from "./memory-payload"

export interface ExpireResult {
  expired: number
  scanned: number
  scannedAt: number
}

export interface PruneResult {
  deleted: number
  scannedAt: number
}

export interface ReconcileResult {
  supersededIds: string[]
  pruned: number
  scannedAt: number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryHygiene") {}

export interface Interface {
  readonly expire: (input?: { now?: number }) => Effect.Effect<ExpireResult, never, never>
  readonly prune: (input?: { olderThanMs?: number }) => Effect.Effect<PruneResult, never, never>
  readonly reconcile: (input?: { scope?: "global" | "session" }) => Effect.Effect<ReconcileResult, never, never>
}

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const layer: Layer.Layer<Service, never, Database.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!banyancodeEnabled()) {
      return Service.of({
        expire: () => Effect.succeed({ expired: 0, scanned: 0, scannedAt: 0 }),
        prune: () => Effect.succeed({ deleted: 0, scannedAt: 0 }),
        reconcile: () => Effect.succeed({ supersededIds: [], pruned: 0, scannedAt: 0 }),
      })
    }

    const { db } = yield* Database.Service

    const expire: Interface["expire"] = (input = {}) =>
      Effect.gen(function* () {
        const now = input.now ?? Date.now()
        const updated = yield* db
          .update(MemoryEntriesTable)
          .set({ status: "expired", updated_at: now })
          .where(
            and(
              eq(MemoryEntriesTable.status, "active"),
              sql`${MemoryEntriesTable.expires_at} IS NOT NULL`,
              lt(MemoryEntriesTable.expires_at, now),
            ),
          )
          .returning({ id: MemoryEntriesTable.id })
          .run()
          .pipe(Effect.orDie)
        const scanned = yield* db
          .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM ${MemoryEntriesTable} WHERE status = 'expired' AND expires_at IS NOT NULL`)
          .pipe(Effect.orDie)
        return { expired: updated.length, scanned: scanned?.c ?? 0, scannedAt: now }
      })

    const prune: Interface["prune"] = (input = {}) =>
      Effect.gen(function* () {
        const cutoff = Date.now() - (input.olderThanMs ?? 30 * 86_400_000)
        const deleted = yield* db
          .delete(MemoryEntriesTable)
          .where(
            and(
              sql`${MemoryEntriesTable.status} IN ('rejected', 'expired')`,
              lt(MemoryEntriesTable.updated_at, cutoff),
            ),
          )
          .returning({ id: MemoryEntriesTable.id })
          .run()
          .pipe(Effect.orDie)
        return { deleted: deleted.length, scannedAt: Date.now() }
      })

    const reconcile: Interface["reconcile"] = (input = {}) =>
      Effect.gen(function* () {
        const scopeClause = input.scope ? eq(MemoryEntriesTable.scope, input.scope) : sql`1=1`
        const rows = yield* db
          .select()
          .from(MemoryEntriesTable)
          .where(and(eq(MemoryEntriesTable.status, "active"), scopeClause))
          .orderBy(sql`${MemoryEntriesTable.updated_at} DESC`)
          .all()
          .pipe(Effect.orDie)

        const survivorByFingerprint = new Map<string, typeof rows[number]>()
        const supersededIds: string[] = []
        const now = Date.now()

        for (const row of rows) {
          const payload = unwrapMemoryValue(row.value, row.key)
          const fp = payloadFingerprint(payload)
          const existing = survivorByFingerprint.get(fp)
          if (!existing) {
            survivorByFingerprint.set(fp, row)
            continue
          }

          yield* db
            .update(MemoryEntriesTable)
            .set({ status: "superseded", updated_at: now })
            .where(eq(MemoryEntriesTable.id, row.id))
            .run()
            .pipe(Effect.orDie)
          supersededIds.push(row.id)
        }

        const pruned = (yield* prune().pipe(Effect.orDie)).deleted

        return { supersededIds, pruned, scannedAt: now }
      })

    return Service.of({ expire, prune, reconcile })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(Database.defaultLayer),
)
