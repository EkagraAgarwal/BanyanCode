import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912120000_agent_efficiency_telemetry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS agent_efficiency_telemetry (event_id TEXT PRIMARY KEY NOT NULL, schema_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL, run_id TEXT NOT NULL, session_id TEXT, parent_session_id TEXT, root_session_id TEXT, agent_instance_id TEXT, agent_role TEXT, depth INTEGER, task_id TEXT, benchmark_id TEXT, experiment_id TEXT, experiment_variant TEXT, model_call_id TEXT, tool_call_id TEXT, finding_id TEXT, parent_event_id TEXT, status TEXT, duration_ms INTEGER, error_category TEXT, metadata TEXT)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS agent_efficiency_telemetry_run_idx ON agent_efficiency_telemetry(run_id, occurred_at)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS agent_efficiency_telemetry_session_idx ON agent_efficiency_telemetry(session_id, occurred_at)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS agent_efficiency_telemetry_agent_idx ON agent_efficiency_telemetry(agent_instance_id, occurred_at)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS agent_efficiency_telemetry_type_idx ON agent_efficiency_telemetry(event_type, occurred_at)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS agent_efficiency_telemetry_time_idx ON agent_efficiency_telemetry(occurred_at)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS agent_efficiency_telemetry_status_idx ON agent_efficiency_telemetry(status, occurred_at)`)
    })
  },
} satisfies DatabaseMigration.Migration
