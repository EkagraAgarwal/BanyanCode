import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { customType } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

// Placeholder dimension for F32_BLOB. At runtime, EmbeddingProviderService.setModel()
// calls resetTable() to recreate with the correct dim before any embeddings are written.
const PLACEHOLDER_DIM = 1536

export const f32Blob = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() { return `F32_BLOB(${PLACEHOLDER_DIM})` },
  toDriver(v) { return v },
  fromDriver(v) { return v instanceof Uint8Array ? v : new Uint8Array(v) },
})

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
    node_id: text("node_id").primaryKey().references(() => CodegraphNodesTable.id, { onDelete: "cascade" }),
    embedding: f32Blob("embedding").notNull(),
    model: text("model").notNull(),
    dim: integer("dim").notNull(),
    created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("codegraph_embedding_model_idx").on(table.model)],
)

console.error("[turso.schema] codegraph_embeddings F32_BLOB(1536) configured (placeholder dim)")
