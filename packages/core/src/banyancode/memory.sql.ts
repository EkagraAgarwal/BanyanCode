import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// libsql JSONB — stored as TEXT, parsed as JSON by the driver.
// Use $type<T>() on the column reference to get typed access.
export const MemoryEntriesTable = sqliteTable(
  "memory_entries",
  {
    id: text().primaryKey(),
    key: text().notNull(),
    // value: jsonb — declared in migration as jsonb NOT NULL
    // Drizzle stores jsonb as TEXT at the driver level (same as text mode:"json")
    value: text({ mode: "json" }).notNull(),
    context: text(),
    // tags: jsonb — declared in migration as jsonb NOT NULL DEFAULT '[]'
    tags: text({ mode: "json" }).$type<string[]>().notNull(),
    scope: text().notNull(),
    session_id: text(),
    created_at: integer().notNull(),
    expires_at: integer(),
    agent_id: text(),
    version: integer().notNull().default(1),
    updated_at: integer().notNull(),
    namespace: text(),
  },
  (table) => [
    index("memory_scope_key_idx").on(table.scope, table.key),
    index("memory_scope_session_idx").on(table.scope, table.session_id),
  ],
)

console.error("[turso.schema] memory_entries with jsonb columns configured")
