import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const CodegraphFilesTable = sqliteTable("codegraph_files", {
  id: text().primaryKey(),
  path: text().notNull().unique(),
  content_hash: text().notNull(),
  language: text().notNull(),
  indexed_at: integer().notNull(),
  size_bytes: integer().notNull().default(0),
  mtime_ms: integer().notNull().default(0),
})

export const CodegraphNodesTable = sqliteTable(
  "codegraph_nodes",
  {
    id: text().primaryKey(),
    file_id: text()
      .notNull()
      .references(() => CodegraphFilesTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    name: text().notNull(),
    signature: text(),
    start_line: integer().notNull(),
    end_line: integer().notNull(),
    code: text(),
    // Phase 3 columns: precomputed ranking signals populated by the
    // indexer after the parse pass. Defaults to 0 so existing rows are
    // unaffected; existing DBs pick these up via the additive migration
    // (see 20260708140000_codegraph_node_entrypoint_signals).
    is_entrypoint: integer().notNull().default(0),
    in_degree: integer().notNull().default(0),
  },
  (table) => [
    index("codegraph_node_file_name_idx").on(table.file_id, table.name),
    index("codegraph_node_kind_name_idx").on(table.kind, table.name),
    // Plan Phase B B1: the `codegraph_node_name_idx` is the runtime source
    // of truth for the leading-column `WHERE name = ?` lookup. It is
    // created by the migration `20260719000000_codegraph_node_name_idx`
    // (registered in `database/migration.gen.ts`). The Drizzle declaration
    // here is kept for `drizzle-kit generate` schema introspection (see
    // `drizzle.config.ts`); it is NOT executed at runtime by Drizzle ORM
    // and the migration uses `CREATE INDEX IF NOT EXISTS`, so the two are
    // safe to coexist.
    index("codegraph_node_name_idx").on(table.name),
    index("codegraph_nodes_is_entrypoint_idx").on(table.is_entrypoint),
    index("codegraph_nodes_in_degree_idx").on(table.in_degree),
  ],
)

export const CodegraphEdgesTable = sqliteTable(
  "codegraph_edges",
  {
    id: text().primaryKey(),
    from_node_id: text()
      .notNull()
      .references(() => CodegraphNodesTable.id, { onDelete: "cascade" }),
    to_node_id: text()
      .notNull()
      .references(() => CodegraphNodesTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    // Phase: edge confidence model. `derivation` is the provenance label
    // (`binding-resolved` / `service-tag` / `same-file` / `heuristic-name`)
    // and `confidence` is the 0-100 trust score the derived-edge pass stamps
    // so traversal consumers can prefer high-confidence edges and report
    // when only heuristic edges exist. Nullable so pre-migration rows keep
    // working; new rows always carry both fields.
    derivation: text(),
    confidence: integer().notNull().default(0),
  },
  (table) => [
    index("codegraph_edge_from_idx").on(table.from_node_id),
    index("codegraph_edge_to_idx").on(table.to_node_id),
    index("codegraph_edge_confidence_idx").on(table.confidence),
  ],
)

// Phase: persisted import/export bindings. One row per import/export/re-export
// statement in a TypeScript file. `writeFileGraph` writes them during the parse
// pass; `rebuildDerivedGraph` reads them to construct binding-aware edges
// (qualified refs, barrel chains) without re-parsing source on every rebuild.
export const CodegraphBindingsTable = sqliteTable(
  "codegraph_bindings",
  {
    id: text().primaryKey(),
    file_id: text()
      .notNull()
      .references(() => CodegraphFilesTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    local_name: text(),
    imported_name: text(),
    export_name: text(),
    source: text().notNull().default(""),
    indexed_at: integer().notNull(),
  },
  (table) => [
    index("codegraph_bindings_file_idx").on(table.file_id),
    index("codegraph_bindings_source_idx").on(table.source),
  ],
)
