import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const CodegraphToolUsageTable = sqliteTable("codegraph_tool_usage", {
  tool_id: text().primaryKey(),
  // Phase C (per-session adoption): additive column recording the session
  // that most recently used the tool. NULL for rows written before the
  // migration or by callers without a session. Lifetime-aggregate semantics
  // are unchanged — tool_id stays the PK; per-session rows are derived by
  // filtering on this column, not stored separately.
  session_id: text(),
  last_used_at: integer().notNull().default(0),
  use_count: integer().notNull().default(0),
})
