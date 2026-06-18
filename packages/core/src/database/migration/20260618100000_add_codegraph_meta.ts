import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260618100000_add_codegraph_meta",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`codegraph_meta\` (
          \`id\` text PRIMARY KEY,
          \`graph_built_at\` integer NOT NULL,
          \`graph_version\` integer NOT NULL,
          \`graph_coverage\` real NOT NULL,
          \`total_files\` integer NOT NULL,
          \`total_nodes\` integer NOT NULL,
          \`total_edges\` integer NOT NULL,
          \`schema_version\` integer NOT NULL
        )`)
    })
  },
} satisfies DatabaseMigration.Migration
