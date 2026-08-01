import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 4 (LSP freshness): durable invalidation event log so the LSP freshness
// service can replay file-change notifications after a process restart, and
// downstream consumers (LSPBridge in a later phase) can `claimUnconsumed` to
// skip the cold-start re-projection of changed files.
//
// The shape is intentionally minimal: kind + path + JSON payload + createdAt +
// consumedAt. There is no per-file de-dup key because Parcel / OS watchers
// already debounce; the LspInvalidationRepo layer below provides an
// idempotent `markConsumed` so a redelivered message is a no-op.
export default {
  id: "20260802120000_lsp_invalidation_events",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`lsp_invalidation_events\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`kind\` text NOT NULL,
          \`path\` text NOT NULL,
          \`payload\` text,
          \`created_at\` integer NOT NULL DEFAULT (unixepoch()),
          \`consumed_at\` integer
        )`)
      yield* tx.run(
        `CREATE INDEX \`lsp_invalidation_unconsumed_idx\` ON \`lsp_invalidation_events\` (\`consumed_at\`) WHERE \`consumed_at\` IS NULL`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
