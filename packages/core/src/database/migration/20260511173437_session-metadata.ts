import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260511173437_session-metadata",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE session ADD COLUMN metadata text`)
    })
  },
} satisfies DatabaseMigration.Migration
