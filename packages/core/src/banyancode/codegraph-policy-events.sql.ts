import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Per-turn graph-policy telemetry events recorded by the common session tool
 * wrapper (`packages/opencode/src/session/tools.ts`). One row per tool call,
 * redirect, or graph attempt — NOT an upsert aggregate. The row-additive
 * design keeps every event (including V1 built-in calls like `read`/`grep`)
 * so the adoption denominator is accurate: graph attempt before fallback,
 * first-use latency, result quality (via `outcome`), and the bootstrap state
 * observed at call time (`graph_state`).
 */
export const CodegraphPolicyEventsTable = sqliteTable(
  "codegraph_policy_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text().notNull(),
    message_id: text().notNull(),
    tool_id: text().notNull(),
    event_type: text().notNull(),
    mode: text().notNull(),
    ts: integer().notNull(),
    graph_state: text(),
    outcome: text(),
  },
  (table) => [
    index("codegraph_policy_events_session_ts").on(table.session_id, table.ts),
    index("codegraph_policy_events_type").on(table.event_type),
    index("codegraph_policy_events_tool").on(table.tool_id),
  ],
)
