import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260708130000_codegraph_service_tags",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE IF NOT EXISTS \`codegraph_service_tags\` (\`id\` text PRIMARY KEY NOT NULL, \`tag\` text NOT NULL, \`service_name\` text NOT NULL, \`file_id\` text NOT NULL, \`node_id\` text NOT NULL, \`class_name\` text NOT NULL, \`indexed_at\` integer NOT NULL)`)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`codegraph_service_tags_tag_idx\` ON \`codegraph_service_tags\` (\`tag\`)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_service_tags_service_name_idx\` ON \`codegraph_service_tags\` (\`service_name\`)`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`codegraph_service_tags_node_id_idx\` ON \`codegraph_service_tags\` (\`node_id\`)`)
    })
  },
} satisfies DatabaseMigration.Migration
