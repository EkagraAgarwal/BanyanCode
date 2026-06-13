import { sqliteTable, text, integer, index, blob } from "drizzle-orm/sqlite-core"

export const CodegraphFilesTable = sqliteTable("codegraph_files", {
  id: text().primaryKey(),
  path: text().notNull().unique(),
  content_hash: text().notNull(),
  language: text().notNull(),
  indexed_at: integer().notNull(),
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
  },
  (table) => [
    index("codegraph_node_file_name_idx").on(table.file_id, table.name),
    index("codegraph_node_kind_name_idx").on(table.kind, table.name),
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
  },
  (table) => [
    index("codegraph_edge_from_idx").on(table.from_node_id),
    index("codegraph_edge_to_idx").on(table.to_node_id),
  ],
)

export const CodegraphEmbeddingsTable = sqliteTable(
  "codegraph_embeddings",
  {
    node_id: text()
      .primaryKey()
      .references(() => CodegraphNodesTable.id, { onDelete: "cascade" }),
    embedding: blob().notNull(),
    model: text().notNull(),
    dim: integer().notNull(),
  },
  (table) => [index("codegraph_embedding_model_idx").on(table.model)],
)
