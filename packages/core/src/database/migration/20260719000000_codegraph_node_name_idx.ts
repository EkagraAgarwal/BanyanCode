import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// Plan Phase 2: a standalone index on `codegraph_nodes.name` makes exact
// symbol lookup O(log n) instead of a full scan. The existing composite
// indexes `(file_id, name)` and `(kind, name)` cannot serve `WHERE name = ?`
// efficiently because name is not their leading column. This migration is
// additive and safe for existing databases.
export default {
  id: "20260719000000_codegraph_node_name_idx",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`codegraph_node_name_idx\` ON \`codegraph_nodes\` (\`name\`)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration