import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20250706120000_codegraph_parse_errors",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS \`codegraph_parse_errors\` (\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL, \`path\` text NOT NULL, \`cause\` text NOT NULL, \`indexed_at\` integer NOT NULL)`)
    })
  },
} satisfies DatabaseMigration.Migration