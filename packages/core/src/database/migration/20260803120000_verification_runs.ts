import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 6 (Verifier): durable record of every typecheck / test / lint / compile
// run the LLM agent requested. Benchmark joins this table against the agent's
// final output to score "did the agent verify before claiming done?" — so the
// shape here has to be cheap to write on every tool call and easy to query by
// kind.
//
// `cache_key` is a deterministic `(kind, path, content_hash, tsconfig_hash)`
// fingerprint set by the verifier service. `summary` is the structured
// pass/fail/errored counters; `raw_output` is the truncated stdout/stderr
// (capped at 64 KB at write time so the table never balloons). `status`
// transitions are 'running' → 'passed' | 'failed' | 'errored'.
export default {
  id: "20260803120000_verification_runs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`verification_runs\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`kind\` text NOT NULL,
          \`target\` text NOT NULL,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL DEFAULT (unixepoch()),
          \`completed_at\` integer,
          \`duration_ms\` integer,
          \`summary\` text,
          \`raw_output\` text,
          \`cache_key\` text
        )
      `)
      yield* tx.run(
        `CREATE INDEX \`verification_runs_kind_completed_idx\` ON \`verification_runs\` (\`kind\`, \`completed_at\` DESC)`,
      )
      yield* tx.run(
        `CREATE INDEX \`verification_runs_cache_key_idx\` ON \`verification_runs\` (\`cache_key\`)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
