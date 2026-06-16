import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// Allowed `kind` values: "request" | "inform" | "answer" | "poll" | "steer" | "checkpoint" | "plan" | "kill"
export const SubagentMessagesTable = sqliteTable(
  "subagent_messages",
  {
    id: text().primaryKey(),
    parent_session_id: text().notNull(),
    from_session: text().notNull(),
    from_agent: text().notNull(),
    to_session: text(),
    to_agent: text(),
    kind: text().notNull(),
    payload: text({ mode: "json" }).notNull(),
    created_at: integer().notNull(),
    delivered_at: integer(),
  },
  (table) => [index("subagent_msg_parent_delivered_idx").on(table.parent_session_id, table.delivered_at)],
)
