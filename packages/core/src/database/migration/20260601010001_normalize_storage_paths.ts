import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260601010001_normalize_storage_paths",
  up() {
    return Effect.sync(() => {})
  },
} satisfies DatabaseMigration.Migration
