import { CliError } from "effect/cli"
import { errorMessage } from "../util/error"

/**
 * Full stacks are for internal defects. They stay behind an explicit debug
 * switch; ordinary failures print one line and the cause still reaches the log
 * file through `Effect.logError`.
 */
export const debugStacks = () =>
  process.env.BANYANCODE_DEBUG === "1" ||
  process.env.OPENCODE_DEBUG === "1" ||
  process.env.OPENCODE_PRINT_LOGS === "1"

/** One-line, user-facing message for a failure that escaped command handling. */
export function errorLine(error: unknown): string {
  const message = CliError.isCliError(error) ? error.message : errorMessage(error)
  const line = message.trim()
  return line.length > 0 ? line : "Unexpected error"
}
