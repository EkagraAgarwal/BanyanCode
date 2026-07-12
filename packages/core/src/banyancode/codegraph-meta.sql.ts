import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core"

export const CodegraphMetaTable = sqliteTable("codegraph_meta", {
  id: text().primaryKey(),                  // always "singleton"
  graph_built_at: integer().notNull(),
  graph_version: integer().notNull(),       // monotonic, bumped ONLY on successful build
  graph_coverage: real().notNull(),         // 0..1, indexedFiles / scannedFiles
  total_files: integer().notNull(),
  total_nodes: integer().notNull(),
  total_edges: integer().notNull(),
  schema_version: integer().notNull(),
  // Workspace root whose files are indexed by this graph. Auto-update only
  // processes file events whose event.location.directory equals this root.
  // Nullable so legacy graphs created before this column existed keep working.
  indexed_root: text(),
})
