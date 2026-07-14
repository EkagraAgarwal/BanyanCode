import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260712000000_codegraph_indexed_root",
  up(tx) {
    return Effect.gen(function* () {
      // Idempotent: guard against re-running when the column already exists.
      // Two processes can race the migration runner's Semaphore(1) if they
      // start simultaneously before the journal entry is written.
      const existing = yield* tx.get<{ name: string }>(
        sql`SELECT name FROM pragma_table_info('codegraph_meta') WHERE name = 'indexed_root'`,
      )
      if (existing) return
      yield* tx.run(`ALTER TABLE \`codegraph_meta\` ADD COLUMN \`indexed_root\` text`)
    })
  },
} satisfies DatabaseMigration.Migration