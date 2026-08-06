import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase: binding-aware edge model. Non-destructive: adds two nullable/defaulted
// columns to `codegraph_edges` (derivation + confidence) and a brand-new
// `codegraph_bindings` table. Existing graph rows keep working; the next full
// rebuild after this migration repopulates edges with derivation/confidence and
// fills the bindings table. `CODEGRAPH_SCHEMA_VERSION` is bumped to 4 so the
// readiness check forces one full reindex.
export default {
  id: "20260806130000_codegraph_bindings_edge_confidence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`codegraph_edges\` ADD COLUMN \`derivation\` text`)
      yield* tx.run(`ALTER TABLE \`codegraph_edges\` ADD COLUMN \`confidence\` integer NOT NULL DEFAULT 0`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_edge_confidence_idx\` ON \`codegraph_edges\` (\`confidence\`)`)
      yield* tx.run(`CREATE TABLE IF NOT EXISTS \`codegraph_bindings\` (\`id\` text PRIMARY KEY NOT NULL, \`file_id\` text NOT NULL REFERENCES \`codegraph_files\`(\`id\`) ON DELETE CASCADE, \`kind\` text NOT NULL, \`local_name\` text, \`imported_name\` text, \`export_name\` text, \`source\` text NOT NULL DEFAULT '', \`indexed_at\` integer NOT NULL)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_bindings_file_idx\` ON \`codegraph_bindings\` (\`file_id\`)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_bindings_source_idx\` ON \`codegraph_bindings\` (\`source\`)`)
    })
  },
} satisfies DatabaseMigration.Migration
