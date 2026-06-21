import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260603040000_session_message_projection_order",
  up() {
    return Effect.sync(() => {})
  },
} satisfies DatabaseMigration.Migration
