import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 5 (enforce-and-measure): add the `codegraph_policy_events` telemetry
// table — one row per per-turn tool call, redirect, or graph attempt, recorded
// by the common session tool wrapper. Purely additive (new table + indexes);
// no existing table is touched.
export default {
  id: "20260806150000_codegraph_policy_events",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        "CREATE TABLE IF NOT EXISTS `codegraph_policy_events` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `session_id` text NOT NULL, `message_id` text NOT NULL, `tool_id` text NOT NULL, `event_type` text NOT NULL, `mode` text NOT NULL, `ts` integer NOT NULL, `graph_state` text, `outcome` text)",
      )
      yield* tx.run(
        "CREATE INDEX IF NOT EXISTS `codegraph_policy_events_session_ts_idx` ON `codegraph_policy_events` (`session_id`, `ts`)",
      )
      yield* tx.run("CREATE INDEX IF NOT EXISTS `codegraph_policy_events_type_idx` ON `codegraph_policy_events` (`event_type`)")
      yield* tx.run("CREATE INDEX IF NOT EXISTS `codegraph_policy_events_tool_idx` ON `codegraph_policy_events` (`tool_id`)")
    })
  },
} satisfies DatabaseMigration.Migration
