import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const SubagentGoalsTable = sqliteTable(
  "subagent_goals",
  {
    id: text().primaryKey(),
    parent_session_id: text().notNull(),
    // Free-text exit criteria, limited to 4,000 characters at the input boundary.
    condition: text().notNull(),
    // Relative path to the plan.md deliverable, when the goal has one.
    plan_path: text(),
    // Priority bucket — matches the steering/action priority literal.
    priority: text(),
    // Lifecycle: active → (achieved | blocked | cancelled).
    status: text().notNull(),
    iteration_count: integer().notNull().default(0),
    last_review_id: text(),
    last_review_verdict: text(),
    last_review_reason: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    achieved_at: integer(),
    blocked_at: integer(),
  },
  (table) => [
    index("subagent_goal_parent_idx").on(table.parent_session_id),
    index("subagent_goal_status_idx").on(table.status),
    index("subagent_goal_session_status_idx").on(table.parent_session_id, table.status),
  ],
)
