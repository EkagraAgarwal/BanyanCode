import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 5 (enforce-and-measure): replace the tool_id-only PK of
// `codegraph_tool_usage` with a composite `(session_id, tool_id)` key so a
// session's usage is never overwritten by a later session. NON-destructive:
// every existing row is copied into the rebuilt table first (legacy
// NULL-session rows are keyed under the `''` sentinel), grouped by the new
// composite key so no counts are lost, then the old table is dropped and the
// new one renamed into place. The migration runs inside a transaction, so a
// failure before the RENAME leaves the old table intact.
export default {
  id: "20260806140000_codegraph_tool_usage_composite_key",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        "CREATE TABLE IF NOT EXISTS `codegraph_tool_usage_new` (`session_id` text NOT NULL DEFAULT '', `tool_id` text NOT NULL, `last_used_at` integer NOT NULL DEFAULT (unixepoch()), `use_count` integer NOT NULL DEFAULT 0, PRIMARY KEY (`session_id`, `tool_id`))",
      )
      yield* tx.run(
        "INSERT INTO `codegraph_tool_usage_new` (`session_id`, `tool_id`, `last_used_at`, `use_count`) SELECT COALESCE(`session_id`, ''), `tool_id`, MAX(`last_used_at`), SUM(`use_count`) FROM `codegraph_tool_usage` GROUP BY COALESCE(`session_id`, ''), `tool_id`",
      )
      yield* tx.run("DROP TABLE `codegraph_tool_usage`")
      yield* tx.run("ALTER TABLE `codegraph_tool_usage_new` RENAME TO `codegraph_tool_usage`")
    })
  },
} satisfies DatabaseMigration.Migration
