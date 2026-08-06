import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806120000_add_session_id",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`codegraph_tool_usage\` ADD \`session_id\` text`)
    })
  },
} satisfies DatabaseMigration.Migration
