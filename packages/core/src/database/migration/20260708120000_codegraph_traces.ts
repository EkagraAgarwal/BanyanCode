import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260708120000_codegraph_traces",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS \`codegraph_traces\` (\`id\` text PRIMARY KEY NOT NULL, \`trace_name\` text NOT NULL, \`from_node_id\` text, \`to_node_id\` text NOT NULL, \`observed_at\` integer NOT NULL, \`observed_at_bucket\` integer NOT NULL)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_traces_trace_idx\` ON \`codegraph_traces\` (\`trace_name\`)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_traces_from_idx\` ON \`codegraph_traces\` (\`from_node_id\`)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_traces_to_idx\` ON \`codegraph_traces\` (\`to_node_id\`)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_traces_observed_at_idx\` ON \`codegraph_traces\` (\`observed_at\`)`)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`codegraph_traces_natural_key_idx\` ON \`codegraph_traces\` (\`trace_name\`, \`from_node_id\`, \`to_node_id\`, \`observed_at_bucket\`)`)
    })
  },
} satisfies DatabaseMigration.Migration