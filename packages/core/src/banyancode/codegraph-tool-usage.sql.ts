import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const CodegraphToolUsageTable = sqliteTable("codegraph_tool_usage", {
  tool_id: text().primaryKey(),
  last_used_at: integer().notNull().default(0),
  use_count: integer().notNull().default(0),
})
