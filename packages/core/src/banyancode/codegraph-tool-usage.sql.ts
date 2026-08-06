import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const CodegraphToolUsageTable = sqliteTable(
  "codegraph_tool_usage",
  {
    session_id: text().notNull().default(""),
    tool_id: text().notNull(),
    last_used_at: integer().notNull().default(0),
    use_count: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.tool_id] })],
)
