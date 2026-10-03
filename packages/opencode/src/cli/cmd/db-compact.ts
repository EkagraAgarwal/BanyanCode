import { statSync } from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMaintenance } from "@opencode-ai/core/database/maintenance"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

const dbBytes = (file: string) =>
  ["", "-wal", "-shm"].reduce((total, suffix) => {
    try {
      return total + statSync(`${file}${suffix}`).size
    } catch {
      return total
    }
  }, 0)

const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`

export const DbCompactCommand = effectCmd({
  command: "compact",
  describe: "run code backfills, event-log compaction and a full VACUUM on the current database",
  instance: false,
  handler: Effect.fn("Cli.db.compact")(function* () {
    // The background maintenance fiber must not race this explicit run.
    process.env.BANYANCODE_DB_MAINTENANCE = "0"
    const { db } = yield* Database.Service
    const file = Database.path()
    const before = dbBytes(file)

    yield* db.run("PRAGMA busy_timeout = 1000").pipe(Effect.orDie)
    const locked = yield* db.run("BEGIN IMMEDIATE").pipe(
      Effect.flatMap(() => db.run("ROLLBACK")),
      Effect.as(false),
      Effect.catchCause(() => Effect.succeed(true)),
    )
    if (locked) return yield* fail("The database is in use by another BanyanCode process. Close other sessions and retry.")

    UI.println(`Compacting ${file} (${mb(before)})`)
    const report = yield* DatabaseMaintenance.run(db, { force: true }).pipe(Effect.orDie)
    UI.println(`Event rows deleted: ${report.compaction?.deletedRows ?? 0}`)
    yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
    yield* db.run(sql`VACUUM`).pipe(
      Effect.catchCause(() => fail("VACUUM failed; another BanyanCode process may hold the database. Close other sessions and retry.")),
    )
    yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
    const after = dbBytes(file)
    UI.println(UI.Style.TEXT_SUCCESS + `Done: ${mb(before)} -> ${mb(after)}` + UI.Style.TEXT_NORMAL)
  }),
})
