import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const SubagentReviewRequestsTable = sqliteTable(
  "subagent_review_requests",
  {
    id: text().primaryKey(),
    parent_session_id: text().notNull(),
    target_agent: text().notNull(),
    diff: text(),
    description: text(),
    // JSON array of file paths the review should focus on.
    paths: text({ mode: "json" }).$type<string[] | null>(),
    // Priority bucket — matches the steering/action priority literal.
    priority: text(),
    reason: text(),
    // Lifecycle: pending → dispatched → (completed | failed). Mirrors the
    // SubagentPlans status literal shape but is not a substring superset —
    // `pending` is not used by plans (which go straight to `active`).
    status: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    // Final result payload (free-shape) once the reviewer subagent returns.
    result: text({ mode: "json" }).$type<unknown>(),
  },
  (table) => [
    index("subagent_review_parent_idx").on(table.parent_session_id),
    index("subagent_review_status_idx").on(table.status),
  ],
)