# BanyanCode — Storage layer

> See `ARCHITECTURE.md` for the broader design. This file covers storage layout in detail.

All BanyanCode persistence lives in the same Drizzle + Effect SQLite stack that `packages/core` already uses. The BanyanCode-specific tables and Effect repos live alongside the existing ones; the `packages/effect-drizzle-sqlite` adapter stays generic.

## Tables

### `memory_entries`

```ts
// packages/core/src/database/schema/memory.sql.ts
export const memoryEntries = sqliteTable("memory_entries", {
  id: text().primaryKey(),
  scope: text({ enum: ["global", "session"] }).notNull(),
  session_id: text(), // nullable; required when scope = "session"
  key: text().notNull(),
  value: text({ mode: "json" }).$type<unknown>().notNull(),
  context: text(),
  tags: text({ mode: "json" }).$type<string[]>().notNull().default("[]"),
  embedding_id: text().references(() => codegraphEmbeddings.id, { onDelete: "set null" }),
  access_count: integer().notNull().default(0),
  last_accessed_at: integer().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  ttl_seconds: integer(), // nullable; null = no expiry
  expires_at: integer(), // generated at write time: created_at + ttl_seconds; null = no expiry
}, (t) => [
  uniqueIndex("memory_scope_key_idx").on(t.scope, t.session_id, t.key),
  index("memory_tags_idx").on(t.tags),
  index("memory_expires_idx").on(t.expires_at),
])
```

### `codegraph_files`

```ts
export const codegraphFiles = sqliteTable("codegraph_files", {
  id: text().primaryKey(),
  path: text().notNull().unique(),
  language: text().notNull(),
  hash: text().notNull(), // sha256 of file content
  node_count: integer().notNull().default(0),
  last_indexed_at: integer().notNull(),
})
```

### `codegraph_nodes`

```ts
export const codegraphNodes = sqliteTable("codegraph_nodes", {
  id: text().primaryKey(),
  kind: text({ enum: ["file", "function", "class", "method", "type", "variable"] }).notNull(),
  name: text().notNull(),
  qualified_name: text().notNull(), // e.g. "src/foo.ts::Bar.baz"
  file_id: text().notNull().references(() => codegraphFiles.id, { onDelete: "cascade" }),
  start_line: integer().notNull(),
  end_line: integer().notNull(),
  language: text().notNull(),
  signature: text(), // function signature or type signature
  doc: text(), // first doc comment
  text_excerpt: text().notNull(), // source snippet used for embedding
  created_at: integer().notNull(),
}, (t) => [
  index("nodes_file_idx").on(t.file_id),
  index("nodes_qualified_idx").on(t.qualified_name),
  index("nodes_kind_idx").on(t.kind),
])
```

### `codegraph_edges`

```ts
export const codegraphEdges = sqliteTable("codegraph_edges", {
  id: text().primaryKey(),
  from_node: text().notNull().references(() => codegraphNodes.id, { onDelete: "cascade" }),
  to_node: text().notNull().references(() => codegraphNodes.id, { onDelete: "cascade" }),
  kind: text({ enum: ["imports", "calls", "extends", "implements", "uses", "references"] }).notNull(),
  file_id: text().notNull().references(() => codegraphFiles.id, { onDelete: "cascade" }),
  line: integer().notNull(),
}, (t) => [
  index("edges_from_idx").on(t.from_node),
  index("edges_to_idx").on(t.to_node),
  index("edges_kind_idx").on(t.kind),
])
```

### `codegraph_embeddings`

```ts
export const codegraphEmbeddings = sqliteTable("codegraph_embeddings", {
  id: text().primaryKey(),
  node_id: text().notNull().unique().references(() => codegraphNodes.id, { onDelete: "cascade" }),
  embedding: blob({ mode: "buffer" }).$type<Buffer>().notNull(),
  model: text().notNull(),
  dim: integer().notNull(),
  created_at: integer().notNull(),
})
```

### `subagent_messages`

```ts
export const subagentMessages = sqliteTable("subagent_messages", {
  id: text().primaryKey(),
  parent_session_id: text().notNull(),
  from_session: text().notNull(),
  from_agent: text().notNull(),
  to_session: text(), // nullable
  to_agent: text(), // nullable; null = broadcast within parent_session_id
  kind: text({ enum: ["request", "inform", "answer", "poll"] }).notNull(),
  payload: text({ mode: "json" }).$type<unknown>().notNull(),
  created_at: integer().notNull(),
  delivered_at: integer(), // nullable; set when read
}, (t) => [
  index("msgs_parent_idx").on(t.parent_session_id),
  index("msgs_recipient_idx").on(t.to_session, t.to_agent),
  index("msgs_unread_idx").on(t.delivered_at),
])
```

## Repos

All three repos (`MemoryRepo`, `CodegraphRepo`, `SubagentMessagesRepo`) follow the existing `Context.Service` pattern in `packages/opencode/src/effect/`. They are wired into the storage layer in `packages/core/src/storage/repo/`.

Constraints from existing code (`packages/opencode/AGENTS.md`):
- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Repo.method")` for named/traced effects.
- Use `Effect.void` instead of `Effect.succeed(undefined)`.
- In `Effect.gen`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure branches.
- Use `Schema.TaggedErrorClass` for typed errors.
- Prefer `Layer.mock` for partial stubs in tests (per `packages/opencode/test/AGENTS.md`).

## Migrations

`packages/core/script/migration.ts` already runs `drizzle-kit` against the schema barrel. Add the new tables to the barrel:

```ts
// packages/core/src/database/schema.sql.ts (extend the existing barrel)
export const Timestamps = { /* unchanged */ }

// Re-export the BanyanCode tables so the Drizzle schema generator sees them:
export * from "./schema/memory.sql"
export * from "./schema/codegraph.sql"
export * from "./schema/subagent-messages.sql"
```

The migration filename follows the existing `YYYYMMDDHHMMSS_*.ts` convention. The latest OpenCode migration is `20260605042240_add_context_epoch_agent.ts`. The first BanyanCode migration is `20260606NNNNNN_banyan_phase1.ts` (e.g., `20260606000001_banyan_phase1.ts`). The migration module is auto-registered by `packages/core/src/database/migration.gen.ts`; `script/migration.ts` regenerates the registry.

## Cross-cutting

- The `BANYANCODE_EMBEDDING_MODEL` env var is read in `packages/core/src/effect/embedding-provider.ts` (Phase 4). The `memory_entries.embedding_id` FK is added in Phase 1 but unused until Phase 4.
- `memory_entries.expires_at` is computed at write time. A `vacuum()` repo method deletes rows where `expires_at < now()`. It runs at the start of every `memory_store` and on a `bun cli banyan memory vacuum` subcommand.
- The BanyanCode tables are all in the same Drizzle schema. The `packages/effect-drizzle-sqlite` adapter sees them through the schema barrel; no adapter changes are required.
