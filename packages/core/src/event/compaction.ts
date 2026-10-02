// One-time and ongoing storage maintenance for the durable event log.
//
// Background: every synchronized event (message/part/session snapshots) is
// appended to the `event` table and never removed except with its aggregate
// (`EventV2.remove`), so intermediate snapshots accumulate forever. The
// `message.updated` / `message.part.updated` rows dominate database size
// because each one embeds a full message/part snapshot.
//
// S1 (compaction): delete superseded snapshot rows in batches, keeping the
// latest row per entity plus a trailing sync-horizon window per aggregate.
// Only last-write-wins snapshot types are compactable; transcript/append
// events (`session.next.*`, created/deleted/removed markers) are never
// touched. Retained rows keep their original `seq`, so live tailing
// (`aggregateEvents({ after })`) is unaffected; cross-instance sync
// bootstraps from a compacted prefix with `replay(..., { allowGaps: true })`.
// `event_sequence` (the per-aggregate high-water mark) is never modified, so
// new publishes continue the sequence after compaction.
//
// Retention is horizon + per-type caps, not wall-clock age: the `event`
// table carries no timestamp, and `evt_` IDs cannot serve as one (the
// 48-bit Identifier.ascending truncation wraps roughly every two years),
// so exact age is unknowable without a schema change.
//
// S2 (patch-body strip): rewrite `diffs` entries to counts-only in existing
// rows. Idempotent: rows without a `patch` key are left alone, so re-runs
// (including the migration in `database/migration.ts`) are no-ops.
//
// Neither operation renumbers sequences: `session_message.seq` and
// `session_input.admitted_seq/promoted_seq` reference event seqs, so
// renumbering would desync the projections.
//
// Full `VACUUM` is deliberately NOT done here: on multi-GB files it blocks
// for minutes. New files get `auto_vacuum=INCREMENTAL` (see
// `database/database.ts`), each open reclaims a bounded number of freelist
// pages via `runStartupMaintenance`, and the one-time full VACUUM belongs in
// `banyancode db gc` (S3), which can ask for confirmation first.
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { EventTable } from "./sql"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

// Journal marker for the S2 backfill (recorded in the shared `migration`
// table by `DatabaseMigration.apply`, same convention as SQL migrations).
export const STRIP_PATCH_BODIES_BACKFILL_ID = "20261002000000_strip_snapshot_patch_bodies"

const MESSAGE_UPDATED = "message.updated.1"
const PART_UPDATED = "message.part.updated.1"
const SESSION_UPDATED = "session.updated.1"

const numberFromEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name])
  if (process.env[name] === undefined || !Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

export interface CompactionConfig {
  // Rows per DELETE statement. Never compacts the whole table at once.
  readonly batch: number
  // Per aggregate, rows with seq above (maxSeq - horizonSeqs) are never
  // deleted: live tail subscribers and recent history are always intact.
  readonly horizonSeqs: number
  // Backstop caps per (aggregate, type) on retained rows. Only ever trim
  // superseded rows inside the horizon window; per-entity latest rows and
  // the single newest row of the group are always kept.
  readonly maxRowsPerAggregateType: number
  readonly maxBytesPerAggregateType: number
  // Versioned event types eligible for compaction. Everything else
  // (transcript appends, created/deleted/removed markers) is untouched.
  readonly compactableTypes: ReadonlyArray<string>
}

export function resolveCompactionConfig(overrides?: Partial<CompactionConfig>): CompactionConfig {
  return {
    batch: Math.max(1, Math.floor(overrides?.batch ?? numberFromEnv("BANYANCODE_EVENT_COMPACT_BATCH", 1000))),
    horizonSeqs: Math.max(
      0,
      Math.floor(overrides?.horizonSeqs ?? numberFromEnv("BANYANCODE_EVENT_COMPACT_HORIZON_SEQS", 100)),
    ),
    maxRowsPerAggregateType: Math.max(
      1,
      Math.floor(
        overrides?.maxRowsPerAggregateType ?? numberFromEnv("BANYANCODE_EVENT_COMPACT_MAX_ROWS_PER_TYPE", 5000),
      ),
    ),
    maxBytesPerAggregateType: Math.max(
      1,
      Math.floor(
        overrides?.maxBytesPerAggregateType ??
          numberFromEnv("BANYANCODE_EVENT_COMPACT_MAX_BYTES_PER_TYPE", 268435456),
      ),
    ),
    compactableTypes: overrides?.compactableTypes ?? [MESSAGE_UPDATED, PART_UPDATED, SESSION_UPDATED],
  }
}

// Entity a snapshot row describes, used to keep the latest row per entity
// rather than per (aggregate, type): a fresh sync subscriber replays the
// retained rows in seq order, and per-entity latest plus all transcript
// rows reconstructs exactly the current projection state. Unknown shapes
// return null and are never deleted.
const defaultEntityOf = (type: string, data: Record<string, unknown>): string | null => {
  const at = (path: ReadonlyArray<string>): string | null => {
    let current: unknown = data
    for (const key of path) {
      if (typeof current !== "object" || current === null) return null
      current = (current as Record<string, unknown>)[key]
    }
    return typeof current === "string" ? current : null
  }
  if (type === MESSAGE_UPDATED) return at(["info", "id"])
  if (type === PART_UPDATED) return at(["part", "id"])
  if (type === SESSION_UPDATED) return at(["sessionID"])
  return null
}

export interface CompactionReport {
  readonly aggregates: number
  readonly scannedRows: number
  readonly deletedRows: number
  readonly batches: number
  readonly bytesFreed: number
}

export interface CompactOptions extends Partial<CompactionConfig> {
  readonly entityOf?: (type: string, data: Record<string, unknown>) => string | null
}

export function compactSnapshots(db: Database, options?: CompactOptions): Effect.Effect<CompactionReport, unknown> {
  return Effect.gen(function* () {
    const config = resolveCompactionConfig(options)
    const entityOf = options?.entityOf ?? defaultEntityOf
    const report: { aggregates: number; scannedRows: number; deletedRows: number; batches: number; bytesFreed: number } =
      { aggregates: 0, scannedRows: 0, deletedRows: 0, batches: 0, bytesFreed: 0 }

    const groups = yield* db
      .select({
        aggregateID: EventTable.aggregate_id,
        type: EventTable.type,
        maxSeq: sql<number>`max(${EventTable.seq})`,
        count: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(length(${EventTable.data})), 0)`,
      })
      .from(EventTable)
      .where(inArray(EventTable.type, [...config.compactableTypes]))
      .groupBy(EventTable.aggregate_id, EventTable.type)
      .all()
    const seenAggregates = new Set<string>()

    for (const group of groups) {
      // Single-row groups have nothing superseded; skip the row scan.
      if (group.count <= 1) continue
      seenAggregates.add(group.aggregateID)
      const rows = yield* db
        .select({ id: EventTable.id, seq: EventTable.seq, data: EventTable.data })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, group.aggregateID), eq(EventTable.type, group.type)))
        .orderBy(desc(EventTable.seq))
        .all()
      report.scannedRows += rows.length

      const seen = new Set<string>()
      const horizonFloor = group.maxSeq - config.horizonSeqs
      const deletable: Array<{ id: string; size: number }> = []
      const horizonKept: Array<{ id: string; seq: number; size: number }> = []
      let retainedRows = 0
      let retainedBytes = 0
      for (const row of rows) {
        const size = JSON.stringify(row.data).length
        const entity = entityOf(group.type, row.data)
        const key = entity ?? row.id
        if (!seen.has(key)) {
          seen.add(key)
          retainedRows += 1
          retainedBytes += size
          continue
        }
        if (row.seq > horizonFloor) {
          horizonKept.push({ id: row.id, seq: row.seq, size })
          retainedRows += 1
          retainedBytes += size
          continue
        }
        deletable.push({ id: row.id, size })
      }

      // Backstop caps trim oldest horizon-kept superseded rows first;
      // per-entity latest rows are never capped away.
      horizonKept.sort((a, b) => a.seq - b.seq)
      while (
        horizonKept.length > 0 &&
        (retainedRows > config.maxRowsPerAggregateType || retainedBytes > config.maxBytesPerAggregateType)
      ) {
        const victim = horizonKept.shift()!
        deletable.push({ id: victim.id, size: victim.size })
        retainedRows -= 1
        retainedBytes -= victim.size
      }

      for (let index = 0; index < deletable.length; index += config.batch) {
        const chunk = deletable.slice(index, index + config.batch).map((row) => row.id)
        yield* db.delete(EventTable).where(inArray(EventTable.id, chunk)).run()
        report.batches += 1
        report.deletedRows += chunk.length
        report.bytesFreed += deletable.slice(index, index + config.batch).reduce((sum, row) => sum + row.size, 0)
      }
    }

    report.aggregates = seenAggregates.size
    return report
  })
}

// Strip per-file unified-diff bodies from `diffs` arrays, keeping
// {file, additions, deletions} counts. Only FileDiff-shaped entries (a
// `patch` key plus numeric additions/deletions or a file key) are touched,
// so unrelated `patch`/`diffs` keys in tool payloads survive. Idempotent:
// output without `patch` keys rewrites to itself with changed=false.
export function stripDiffsPatches(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const stripped = stripDiffsPatches(entry)
      changed = changed || stripped.changed
      return stripped.value
    })
    return changed ? { value: next, changed: true } : { value, changed: false }
  }
  if (typeof value !== "object" || value === null) return { value, changed: false }
  const record = value as Record<string, unknown>
  let changed = false
  // Bare FileDiff-shaped objects (e.g. entries of the session.summary_diffs
  // array, which has no wrapping `diffs` key) lose their patch body here.
  // The shape guard keeps unrelated `patch` keys in tool payloads intact.
  const self: Record<string, unknown> = { ...record }
  if (
    "patch" in self &&
    (typeof self.additions === "number" || typeof self.deletions === "number" || "file" in self)
  ) {
    const { patch: _removed, ...rest } = self
    changed = true
    for (const key of Object.keys(self)) delete self[key]
    Object.assign(self, rest)
  }
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(self)) {
    if (key === "diffs" && Array.isArray(entry)) {
      const stripped = entry.map((diff) => {
        const result = stripDiffsPatches(diff)
        changed = changed || result.changed
        return result.value
      })
      next[key] = stripped
      continue
    }
    const stripped = stripDiffsPatches(entry)
    changed = changed || stripped.changed
    next[key] = stripped.value
  }
  return changed ? { value: next, changed: true } : { value, changed: false }
}

export interface StripReport {
  readonly scanned: number
  readonly rewritten: number
  readonly batches: number
}

// Batched, non-destructive S2 backfill: walk `event`, `message`, `part`
// JSON bodies plus `session.summary_diffs`, rewriting `diffs` entries to
// counts-only. Rows are keyset-paginated by PK (`id > lastId`), each batch
// commits on its own, and progress is reported per batch. Safe to re-run:
// the `"patch":` LIKE prefilter plus the structural FileDiff check mean the
// second run rewrites zero rows.
export function stripSnapshotPatchBodies(
  db: Database,
  options?: { readonly batch?: number },
): Effect.Effect<StripReport, unknown> {
  return Effect.gen(function* () {
    const batch = Math.max(1, Math.floor(options?.batch ?? Number(process.env.BANYANCODE_STRIP_PATCH_BATCH ?? 500)))
    const report = { scanned: 0, rewritten: 0, batches: 0 }

    const stripTable = (table: "event" | "message" | "part"): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        let lastId = ""
        for (;;) {
          const rows = yield* db.all<{ id: string; body: string }>(
            sql`SELECT id, ${sql.identifier("data")} AS body FROM ${sql.identifier(table)} WHERE id > ${lastId} AND ${sql.identifier("data")} LIKE '%"patch":%' ORDER BY id LIMIT ${batch}`,
          )
          if (rows.length === 0) return
          report.batches += 1
          for (const row of rows) {
            lastId = row.id
            report.scanned += 1
            let parsed: unknown
            try {
              parsed = JSON.parse(row.body)
            } catch {
              continue
            }
            const stripped = stripDiffsPatches(parsed)
            if (!stripped.changed) continue
            yield* db.run(
              sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier("data")} = ${JSON.stringify(stripped.value)} WHERE id = ${row.id}`,
            )
            report.rewritten += 1
          }
          if (rows.length < batch) return
          yield* Effect.logInfo("strip patch bodies progress", { table, scanned: report.scanned, rewritten: report.rewritten })
        }
      })

    yield* stripTable("event")
    yield* stripTable("message")
    yield* stripTable("part")

    let lastSessionId = ""
    for (;;) {
      const rows = yield* db.all<{ id: string; body: string }>(
        sql`SELECT id, summary_diffs AS body FROM session WHERE id > ${lastSessionId} AND summary_diffs IS NOT NULL AND summary_diffs LIKE '%"patch":%' ORDER BY id LIMIT ${batch}`,
      )
      if (rows.length === 0) break
      report.batches += 1
      for (const row of rows) {
        lastSessionId = row.id
        report.scanned += 1
        let parsed: unknown
        try {
          parsed = typeof row.body === "string" ? JSON.parse(row.body) : row.body
        } catch {
          continue
        }
        const stripped = stripDiffsPatches(parsed)
        if (!stripped.changed) continue
        yield* db.run(sql`UPDATE session SET summary_diffs = ${JSON.stringify(stripped.value)} WHERE id = ${row.id}`)
        report.rewritten += 1
      }
      if (rows.length < batch) break
      yield* Effect.logInfo("strip patch bodies progress", {
        table: "session",
        scanned: report.scanned,
        rewritten: report.rewritten,
      })
    }

    return report
  })
}

export interface MaintenanceReport {
  readonly freelistPages: number
  readonly vacuumedPages: number
}

// One-time-per-startup cheap maintenance pass. Bounded `incremental_vacuum`
// reclaims at most N freelist pages and is a no-op when the file never had
// a full VACUUM (fresh files get `auto_vacuum=INCREMENTAL` at creation, so
// the flag is ready for the S3 one-time `banyancode db gc` VACUUM, which is
// what actually enables incremental mode on existing files). Never a full
// VACUUM here: on multi-GB files that blocks startup for minutes.
// Disable with BANYANCODE_DB_MAINTENANCE=0.
export function runStartupMaintenance(db: Database): Effect.Effect<MaintenanceReport, unknown> {
  return Effect.gen(function* () {
    if (process.env.BANYANCODE_DB_MAINTENANCE === "0") return { freelistPages: 0, vacuumedPages: 0 }
    const before = yield* db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`)
    const pages = before?.freelist_count ?? 0
    if (pages === 0) return { freelistPages: 0, vacuumedPages: 0 }
    const budget = Math.max(0, Math.floor(numberFromEnv("BANYANCODE_DB_INCREMENTAL_VACUUM_PAGES", 2000)))
    yield* db.run(`PRAGMA incremental_vacuum(${budget})`)
    const after = yield* db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`)
    return { freelistPages: pages, vacuumedPages: pages - (after?.freelist_count ?? pages) }
  })
}
