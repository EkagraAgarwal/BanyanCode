import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260712000000_codegraph_indexed_root",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`codegraph_meta\` ADD COLUMN \`indexed_root\` text`)
    })
  },
} satisfies DatabaseMigration.Migration
