import { Goal } from "@opencode/schema/goal"
import { Effect } from "effect"
import type { Connection } from "../client"

/**
 * v2's goal mode is the host's `opencode.goal` plugin: it owns the state and
 * only exposes `get` (plus a `changed` event). Setting / cancelling a goal is
 * therefore done by running its `/goal` command through `session.command`,
 * exactly like the TUI's slash command and the `goal` tool do.
 */
export const goalClient = (client: Connection["client"]) => client.rpc(Goal.Definition)

export const readGoal = (client: Connection["client"], sessionID: string) =>
  Effect.tryPromise({ try: () => goalClient(client).get({ sessionID }), catch: (cause) => cause })

export const runGoalCommand = (client: Connection["client"], sessionID: string, text: string) =>
  Effect.tryPromise({
    try: () => client.session.command({ sessionID, name: "goal", text }),
    catch: (cause) => cause,
  })

export const shortCondition = (condition: string) =>
  condition.length > 80 ? condition.slice(0, 80) + "…" : condition

/** v2 has no per-goal plan/priority fields; keep v1's labels for scripts. */
export const NO_PLAN = "(none)"
export const NO_PRIORITY = "(default)"
