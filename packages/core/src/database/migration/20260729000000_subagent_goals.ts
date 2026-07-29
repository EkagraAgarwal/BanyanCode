import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Add durable goal lifecycle state for the `/goal` orchestrator loop.
export default {
  id: "20260729000000_subagent_goals",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`subagent_goals\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`condition\` text NOT NULL,
          \`plan_path\` text,
          \`priority\` text,
          \`status\` text NOT NULL,
          \`iteration_count\` integer DEFAULT 0 NOT NULL,
          \`last_review_id\` text,
          \`last_review_verdict\` text,
          \`last_review_reason\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`achieved_at\` integer,
          \`blocked_at\` integer
        )`)
      yield* tx.run(`CREATE INDEX \`subagent_goal_parent_idx\` ON \`subagent_goals\` (\`parent_session_id\`)`)
      yield* tx.run(`CREATE INDEX \`subagent_goal_status_idx\` ON \`subagent_goals\` (\`status\`)`)
      yield* tx.run(
        `CREATE INDEX \`subagent_goal_session_status_idx\` ON \`subagent_goals\` (\`parent_session_id\`, \`status\`)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
