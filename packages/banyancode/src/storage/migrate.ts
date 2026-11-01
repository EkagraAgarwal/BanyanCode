import { query, run } from "./driver.js"
import type { NativeDatabase } from "./native.js"
import { migrations } from "./migrations.js"

export type FtsTokenizer = "trigram" | "unicode61"

export interface MigrationResult {
  /** Ids applied by this call (empty when the database was already current). */
  readonly applied: readonly string[]
  /** Every id recorded in `banyancode_migrations` after this call. */
  readonly ids: readonly string[]
  /** Monotonic schema version: the number of recorded migrations. */
  readonly version: number
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS banyancode_migrations (
  id text PRIMARY KEY NOT NULL,
  applied_at integer NOT NULL
)`

/**
 * Applies pending migrations in order, each inside its own transaction, and
 * records the id. Re-running is a no-op: the id check and the insert happen
 * under `BEGIN IMMEDIATE`, and callers additionally hold the cross-process
 * file lock (see storage/service.ts).
 */
export const applyMigrations = (db: NativeDatabase): MigrationResult => {
  db.exec(MIGRATIONS_TABLE)
  const recorded = new Set(query<{ id: string }>(db, "SELECT id FROM banyancode_migrations").map((row) => row.id))
  const applied: string[] = []
  const now = Math.floor(Date.now() / 1000)

  for (const migration of migrations) {
    if (recorded.has(migration.id)) continue
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const statement of migration.statements) db.exec(statement)
      run(db, "INSERT INTO banyancode_migrations (id, applied_at) VALUES (?, ?)", [migration.id, now])
      db.exec("COMMIT")
      applied.push(migration.id)
      recorded.add(migration.id)
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // SQLite may already have rolled back a failed DDL statement.
      }
      throw error
    }
  }

  const ids = query<{ id: string }>(db, "SELECT id FROM banyancode_migrations ORDER BY id").map((row) => row.id)
  return { applied, ids, version: ids.length }
}

export const detectFtsTokenizer = (db: NativeDatabase): FtsTokenizer => {
  const row = query<{ sql: string | null }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codegraph_nodes_fts'",
  )[0]
  return row?.sql?.includes("trigram") ? "trigram" : "unicode61"
}
