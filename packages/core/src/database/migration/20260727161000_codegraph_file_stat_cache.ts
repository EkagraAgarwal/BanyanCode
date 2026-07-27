import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727161000_codegraph_file_stat_cache",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`codegraph_files\` ADD COLUMN \`size_bytes\` integer NOT NULL DEFAULT 0`)
      yield* tx.run(`ALTER TABLE \`codegraph_files\` ADD COLUMN \`mtime_ms\` integer NOT NULL DEFAULT 0`)
    })
  },
} satisfies DatabaseMigration.Migration
