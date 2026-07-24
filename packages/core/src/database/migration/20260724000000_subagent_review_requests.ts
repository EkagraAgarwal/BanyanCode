import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Phase 1D (G4) migration: add `subagent_review_requests` table for the
// `mesh_control.review` action and its opencode-side bridge.
//
// Lifecycle: pending → dispatched → (completed | failed). Each row carries
// the review spec (diff / description / paths / priority / reason) plus
// the optional final result payload that the reviewer subagent writes back.
//
// The table mirrors `subagent_plans` structurally (id, parent_session_id,
// created/updated timestamps, JSON result column) but is independent — the
// review lifecycle does not have a step list and the dispatch flow is
// out-of-process (orchestrator core publishes, opencode bridge consumes).
export default {
  id: "20260724000000_subagent_review_requests",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`subagent_review_requests\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`target_agent\` text NOT NULL,
          \`diff\` text,
          \`description\` text,
          \`paths\` text,
          \`priority\` text,
          \`reason\` text,
          \`status\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`result\` text
        )`)
      yield* tx.run(`CREATE INDEX \`subagent_review_parent_idx\` ON \`subagent_review_requests\` (\`parent_session_id\`)`)
      yield* tx.run(`CREATE INDEX \`subagent_review_status_idx\` ON \`subagent_review_requests\` (\`status\`)`)
    })
  },
} satisfies DatabaseMigration.Migration