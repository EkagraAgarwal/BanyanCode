import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// Phase 6 (Verifier): durable record of every typecheck / test / lint / compile
// run the LLM agent requested. Mirrors the SQL schema in
// `migration/20260803120000_verification_runs.ts`.
//
// `kind` is one of 'typecheck' | 'test' | 'lint' | 'compile'.
// `status` is 'running' | 'passed' | 'failed' | 'errored'.
// `summary` is a free-form JSON blob the verifier service writes — usually
//   `{ passed: N, failed: M, errored: K }` for tests, or empty for typecheck.
// `cache_key` is a deterministic `(kind, path, content_hash, tsconfig_hash)`
//   fingerprint; nullable because not every run is cache-eligible.
export const VerificationRunsTable = sqliteTable(
  "verification_runs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    target: text().notNull(),
    status: text().notNull(),
    started_at: integer().notNull(),
    completed_at: integer(),
    duration_ms: integer(),
    // JSON-typed as $type<SummaryShape>() — kept loose here because the verifier
    // service may evolve the shape (e.g. add `warnings` for typecheck).
    summary: text({ mode: "json" }).$type<unknown>(),
    raw_output: text(),
    cache_key: text(),
  },
  (table) => [
    index("verification_runs_kind_completed_idx").on(table.kind, table.completed_at),
    index("verification_runs_cache_key_idx").on(table.cache_key),
  ],
)
