import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260614000000_subagent_plans",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`subagent_plans\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`steps\` text NOT NULL,
          \`exit_criteria\` text NOT NULL,
          \`status\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        )`)
      yield* tx.run(`CREATE INDEX \`subagent_plan_parent_idx\` ON \`subagent_plans\` (\`parent_session_id\`)`)
      yield* tx.run(`CREATE INDEX \`subagent_plan_session_idx\` ON \`subagent_plans\` (\`session_id\`)`)
    })
  },
} satisfies DatabaseMigration.Migration
