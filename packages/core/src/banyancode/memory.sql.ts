import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { CodegraphEmbeddingsTable } from "./codegraph.sql"

export const MemoryEntriesTable = sqliteTable("memory_entries", {
  id: text().primaryKey(),
  key: text().notNull(),
  value: text({ mode: "json" }).notNull(),
  context: text(),
  tags: text({ mode: "json" }).$type<string[]>().notNull(),
  scope: text().notNull(),
  session_id: text(),
  embedding_id: text().references(() => CodegraphEmbeddingsTable.id, { onDelete: "set null" }),
  access_count: integer().notNull().default(0),
  last_accessed_at: integer().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  ttl_seconds: integer(),
  expires_at: integer(),
}, (t) => [
  uniqueIndex("memory_scope_session_key_idx").on(t.scope, t.session_id, t.key),
  index("memory_expires_idx").on(t.expires_at),
  index("memory_tags_idx").on(t.tags),
])
