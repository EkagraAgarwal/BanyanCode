import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const SubagentPlansTable = sqliteTable(
  "subagent_plans",
  {
    id: text().primaryKey(),
    parent_session_id: text().notNull(),
    agent: text().notNull(),
    session_id: text().notNull(),
    title: text().notNull(),
    steps: text({ mode: "json" }).$type<Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>>().notNull(),
    exit_criteria: text().notNull(),
    status: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("subagent_plan_parent_idx").on(table.parent_session_id),
    index("subagent_plan_session_idx").on(table.session_id),
  ],
)
