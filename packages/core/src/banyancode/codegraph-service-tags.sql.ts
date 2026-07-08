import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const CodegraphServiceTagsTable = sqliteTable(
  "codegraph_service_tags",
  {
    id: text().primaryKey(),
    tag: text().notNull(),
    service_name: text().notNull(),
    file_id: text().notNull(),
    node_id: text().notNull(),
    class_name: text().notNull(),
    indexed_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("codegraph_service_tags_tag_idx").on(table.tag),
    index("codegraph_service_tags_service_name_idx").on(table.service_name),
    index("codegraph_service_tags_node_id_idx").on(table.node_id),
  ],
)
