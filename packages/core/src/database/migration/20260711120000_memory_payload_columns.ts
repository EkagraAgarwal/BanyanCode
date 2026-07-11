import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 1a: add denormalized columns so FTS triggers + filters can read
// kind / title / body / status directly from the row. SQLite ALTER TABLE
// ADD COLUMN is metadata-only; no table rebuild required.
export default {
  id: "20260711120000_memory_payload_columns",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`memory_entries\` ADD COLUMN \`kind\` text`)
      yield* tx.run(`ALTER TABLE \`memory_entries\` ADD COLUMN \`title\` text`)
      yield* tx.run(`ALTER TABLE \`memory_entries\` ADD COLUMN \`body\` text`)
      yield* tx.run(
        `ALTER TABLE \`memory_entries\` ADD COLUMN \`status\` text NOT NULL DEFAULT 'active'`,
      )

      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`memory_status_updated_idx\` ON \`memory_entries\` (\`status\`, \`updated_at\`)`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`memory_kind_status_idx\` ON \`memory_entries\` (\`kind\`, \`status\`)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration