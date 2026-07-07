import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

export const CodegraphTracesTable = sqliteTable(
  "codegraph_traces",
  {
    id: text().primaryKey(),
    trace_name: text().notNull(),
    from_node_id: text(),
    to_node_id: text().notNull(),
    observed_at: integer().notNull(),
    observed_at_bucket: integer().notNull(),
  },
  (table) => [
    index("codegraph_traces_trace_idx").on(table.trace_name),
    index("codegraph_traces_from_idx").on(table.from_node_id),
    index("codegraph_traces_to_idx").on(table.to_node_id),
    index("codegraph_traces_observed_at_idx").on(table.observed_at),
    uniqueIndex("codegraph_traces_natural_key_idx").on(
      table.trace_name,
      table.from_node_id,
      table.to_node_id,
      table.observed_at_bucket,
    ),
  ],
)