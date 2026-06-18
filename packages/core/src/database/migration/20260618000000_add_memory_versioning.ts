import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260618000000_add_memory_versioning",
  up(tx) {
    return Effect.gen(function* () {
      // Add agent_id column (nullable for legacy rows)
      yield* tx.run(`ALTER TABLE \`memory_entries\` ADD COLUMN \`agent_id\` text`)

      // Add version column with default 1
      yield* tx.run(`ALTER TABLE \`memory_entries\` ADD COLUMN \`version\` integer NOT NULL DEFAULT 1`)

      // Add updated_at column - SQLite doesn't support DEFAULT (column) for ALTER TABLE
      // so we add it with a placeholder default and will need to rely on the app to handle legacy rows
      yield* tx.run(`ALTER TABLE \`memory_entries\` ADD COLUMN \`updated_at\` integer NOT NULL DEFAULT 0`)

      // Add namespace column (derived from key, nullable for legacy unprefixed keys)
      yield* tx.run(`ALTER TABLE \`memory_entries\` ADD COLUMN \`namespace\` text`)

      // Backfill updated_at from created_at for existing rows (version 1 for all legacy)
      yield* tx.run(`UPDATE \`memory_entries\` SET \`updated_at\` = \`created_at\` WHERE \`updated_at\` = 0`)
    })
  },
} satisfies DatabaseMigration.Migration