import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Drops the codegraph_embeddings table and its two indexes.
// Non-destructive — only removes the embeddings subsystem; other codegraph tables
// (files, nodes, edges, meta, FTS) are untouched.
export default {
  id: "20260625120000_drop_codegraph_embeddings",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`codegraph_embedding_vec_idx\``)
      yield* tx.run(`DROP INDEX IF EXISTS \`codegraph_embedding_model_idx\``)
      yield* tx.run(`DROP TABLE IF EXISTS \`codegraph_embeddings\``)
    })
  },
} satisfies DatabaseMigration.Migration
