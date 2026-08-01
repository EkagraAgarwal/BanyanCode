import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// Phase 4 (LSP freshness): durable log of file-change notifications the
// LSPFreshness service emits. Each row is one event the freshness layer
// observed (kind + path + optional JSON payload) and a nullable `consumed_at`
// timestamp that downstream consumers stamp once the event has been applied
// to LSP session state. The partial index on `consumed_at IS NULL` keeps the
// "give me the next unconsumed batch" query fast as the table grows.
export const LspInvalidationEventsTable = sqliteTable(
  "lsp_invalidation_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    path: text().notNull(),
    // Free-form JSON metadata (mtime, language, etc). Stored as TEXT at the
    // driver level (same as `text({ mode: "json" })`); typed via $type<unknown>()
    // because the shape depends on the kind.
    payload: text({ mode: "json" }).$type<unknown>(),
    created_at: integer().notNull(),
    consumed_at: integer(),
  },
  (table) => [
    index("lsp_invalidation_unconsumed_idx").on(table.consumed_at),
  ],
)
