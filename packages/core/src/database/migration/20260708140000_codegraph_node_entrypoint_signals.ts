import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 3 migration: add `is_entrypoint` + `in_degree` columns to
// `codegraph_nodes` so the trace ranker can sort transitive dependents
// without doing N parallel COUNT queries at lookup time.
//
// Both columns are additive (default 0) so existing rows keep working
// and the indexer's heuristics fill them in during the next build.
export default {
  id: "20260708140000_codegraph_node_entrypoint_signals",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`codegraph_nodes\` ADD COLUMN \`is_entrypoint\` integer NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE \`codegraph_nodes\` ADD COLUMN \`in_degree\` integer NOT NULL DEFAULT 0`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_nodes_is_entrypoint_idx\` ON \`codegraph_nodes\` (\`is_entrypoint\`)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_nodes_in_degree_idx\` ON \`codegraph_nodes\` (\`in_degree\`)`)
    })
  },
} satisfies DatabaseMigration.Migration