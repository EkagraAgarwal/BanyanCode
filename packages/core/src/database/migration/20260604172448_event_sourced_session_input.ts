import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260604172448_event_sourced_session_input",
  up() {
    return Effect.sync(() => {})
  },
} satisfies DatabaseMigration.Migration
