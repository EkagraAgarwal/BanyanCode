import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const MemoryEntriesTable = sqliteTable(
  "memory_entries",
  {
    id: text().primaryKey(),
    key: text().notNull(),
    value: text({ mode: "json" }).notNull(),
    context: text(),
    tags: text({ mode: "json" }).$type<string[]>().notNull(),
    scope: text().notNull(),
    session_id: text(),
    created_at: integer().notNull(),
    expires_at: integer(),
  },
  (table) => [
    index("memory_scope_key_idx").on(table.scope, table.key),
    index("memory_scope_session_idx").on(table.scope, table.session_id),
  ],
)
