import { sqliteTable, text, integer, index, blob, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"

export const CodegraphRootsTable = sqliteTable("codegraph_roots", {
  id: text().primaryKey(),
  root_path: text().notNull().unique(),
  last_build_at: integer(),
  indexed_file_count: integer().notNull().default(0),
  node_count: integer().notNull().default(0),
  edge_count: integer().notNull().default(0),
  embedding_model: text(),
  parser_version: text().notNull().default("v1"),
  created_at: integer().notNull(),
})

export const CodegraphFilesTable = sqliteTable("codegraph_files", {
  id: text().primaryKey(),
  root_id: text().notNull().references(() => CodegraphRootsTable.id, { onDelete: "cascade" }),
  path: text().notNull(),
  content_hash: text().notNull(),
  byte_size: integer().notNull(),
  language: text().notNull(),
  parser_version: text().notNull().default("v1"),
  indexed_at: integer().notNull(),
}, (t) => [
  uniqueIndex("codegraph_files_root_path_idx").on(t.root_id, t.path),
  index("codegraph_files_language_idx").on(t.language),
])

export const CodegraphNodesTable = sqliteTable("codegraph_nodes", {
  id: text().primaryKey(),
  file_id: text().notNull().references(() => CodegraphFilesTable.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  name: text().notNull(),
  qualified_name: text().notNull(),
  start_line: integer().notNull(),
  start_byte: integer().notNull(),
  end_line: integer().notNull(),
  end_byte: integer().notNull(),
  language: text().notNull(),
  signature: text(),
  doc: text(),
  text_excerpt: text().notNull(),
  node_code_hash: text().notNull(),
  created_at: integer().notNull(),
}, (t) => [
  index("codegraph_nodes_file_idx").on(t.file_id),
  index("codegraph_nodes_qualified_idx").on(t.qualified_name),
  index("codegraph_nodes_kind_idx").on(t.kind),
  uniqueIndex("codegraph_nodes_file_qname_idx").on(t.file_id, t.qualified_name),
])

export const CodegraphEdgesTable = sqliteTable("codegraph_edges", {
  id: text().primaryKey(),
  from_node_id: text().notNull().references(() => CodegraphNodesTable.id, { onDelete: "cascade" }),
  to_node_id: text(),
  to_target_key: text(),
  file_id: text().notNull().references(() => CodegraphFilesTable.id, { onDelete: "cascade" }),
  line: integer().notNull(),
  kind: text().notNull(),
  weight: integer().notNull().default(1),
}, (t) => [
  index("codegraph_edges_from_idx").on(t.from_node_id),
  index("codegraph_edges_to_idx").on(t.to_node_id),
  index("codegraph_edges_kind_idx").on(t.kind),
  index("codegraph_edges_target_key_idx").on(t.to_target_key),
  index("codegraph_edges_file_idx").on(t.file_id),
])

export const CodegraphEmbeddingsTable = sqliteTable("codegraph_embeddings", {
  id: text().primaryKey(),
  node_id: text().notNull().references(() => CodegraphNodesTable.id, { onDelete: "cascade" }),
  embedding: blob({ mode: "buffer" }).notNull(),
  model: text().notNull(),
  base_url_hash: text().notNull(),
  input_hash: text().notNull(),
  dim: integer().notNull(),
  encoding_format: text().notNull().default("float"),
  created_at: integer().notNull(),
}, (t) => [
  uniqueIndex("codegraph_embeddings_node_model_base_idx").on(t.node_id, t.model, t.base_url_hash),
  index("codegraph_embeddings_model_idx").on(t.model),
])

// FTS5 virtual table for lexical search. Drizzle's `sqliteTable` doesn't have a typed
// primitive for virtual tables; we declare a sentinel so the schema generator still sees
// the table name. The actual CREATE VIRTUAL TABLE statement lives in the migration SQL.
export const CodegraphFtsTable = sqliteTable("codegraph_fts", {
  node_id: text().notNull(),
  qualified_name: text().notNull(),
  name: text().notNull(),
  doc: text(),
  text_excerpt: text().notNull(),
})
