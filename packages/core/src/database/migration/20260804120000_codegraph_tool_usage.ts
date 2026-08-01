import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804120000_codegraph_tool_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS \`codegraph_tool_usage\` (\`tool_id\` text PRIMARY KEY NOT NULL, \`last_used_at\` integer NOT NULL DEFAULT (unixepoch()), \`use_count\` integer NOT NULL DEFAULT 0)`)
    })
  },
} satisfies DatabaseMigration.Migration
