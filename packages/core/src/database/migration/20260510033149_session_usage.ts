import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260510033149_session_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session\` (
          \`id\` text PRIMARY KEY,
          \`time_updated\` integer NOT NULL,
          \`cost\` real NOT NULL DEFAULT 0,
          \`tokens_input\` integer NOT NULL DEFAULT 0,
          \`tokens_output\` integer NOT NULL DEFAULT 0,
          \`tokens_reasoning\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_read\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_write\` integer NOT NULL DEFAULT 0
        )`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL
        )`)
    })
  },
} satisfies DatabaseMigration.Migration
