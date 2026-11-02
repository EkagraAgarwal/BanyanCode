import type { Context } from "@opencode/plugin/effect/plugin"
import { Goal } from "@opencode/schema/goal"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

/**
 * v1 `goal` LLM tool (`packages/core/src/tool/goal.ts`) bridged onto v2's
 * native goal mode.
 *
 * v2 owns goal state in the built-in `opencode.goal` plugin
 * (`packages/core/src/plugin/goal.ts`): state lives in that plugin's KV
 * namespace, `/goal` is its command, and the loop is judged by the goal
 * reviewer. The banyancode plugin therefore cannot write the state directly;
 * it drives the command (`ctx.session.command`) and reads and updates the
 * state through the goal RPC (`opencode.goal.*`). That gives the model
 * set/status/list/pause/resume/cancel plus v1's review actions without a
 * second source of truth:
 *
 *  - `record_review` counts one loop round through `opencode.goal.review`, and
 *    the goal plugin pauses the goal once the round budget
 *    (`banyancode_max_goal_iterations`) runs out — v1's auto-block on
 *    `max iterations reached`. `reviewID` is accepted for v1 compatibility
 *    and ignored: v2 keeps no per-review records.
 *  - `complete` settles the goal `complete` through `opencode.goal.settle`.
 *  - `block` settles the goal `paused` with the blocking reason. v2's status
 *    set is active/paused/complete, so the user-visible effect matches v1's
 *    `blocked`: the loop stops and the reason is shown, and `/goal resume`
 *    remains available.
 *
 * Runtime tuning (`banyancode_max_goal_iterations`,
 * `banyancode_goal_max_time_ms`, `banyancode_goal_auto_retry_on_block`,
 * `banyancode_goal_evaluator_model`) is pushed into the goal plugin at boot
 * and on every config change via `opencode.goal.configure`.
 */

export const GOAL_TOOL = "goal"

const Actions = ["set", "status", "list", "pause", "resume", "cancel", "record_review", "complete", "block"] as const

export const Input = Schema.Struct({
  action: Schema.Literals(Actions),
  condition: Schema.optional(Schema.String),
  /** v1 compatibility: accepted and ignored, because v2 goals carry no plan or priority. */
  planPath: Schema.optional(Schema.String),
  /** v1 compatibility: accepted and ignored, because v2 goals carry no plan or priority. */
  priority: Schema.optional(Schema.Literals(["low", "normal", "high"])),
  /** v1 compatibility: the goal the action applies to. Checked against the Session's goal when given. */
  goalID: Schema.optional(Schema.String),
  /** v1 compatibility: accepted and ignored, because v2 keeps no per-review records. */
  reviewID: Schema.optional(Schema.String),
  verdict: Schema.optional(Goal.Verdict),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan.GoalToolInput" })

export type Input = typeof Input.Type

export const Output = Schema.Struct({
  ok: Schema.Boolean,
  goal: Schema.optional(Schema.NullOr(Schema.Unknown)),
  message: Schema.optional(Schema.String),
  /** v1's `record_review` result: the loop ended because the round budget ran out. */
  loopEnded: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Banyan.GoalToolOutput" })

export type Output = typeof Output.Type

/**
 * Map `banyancode.json` onto the goal plugin's `Settings`. Only keys the user
 * set are forwarded, so an absent key keeps the plugin's stock behavior; a
 * removed key clears a previous override because `configure` replaces the set.
 */
export const settingsFromConfig = (config: {
  readonly banyancode_max_goal_iterations?: number | undefined
  readonly banyancode_goal_max_time_ms?: number | undefined
  readonly banyancode_goal_auto_retry_on_block?: boolean | undefined
  readonly banyancode_goal_evaluator_model?: string | undefined
}): Goal.Settings => ({
  ...(config.banyancode_max_goal_iterations !== undefined
    ? { maxRounds: config.banyancode_max_goal_iterations }
    : {}),
  ...(config.banyancode_goal_max_time_ms !== undefined ? { maxTimeMs: config.banyancode_goal_max_time_ms } : {}),
  ...(config.banyancode_goal_auto_retry_on_block !== undefined
    ? { autoRetryOnBlock: config.banyancode_goal_auto_retry_on_block }
    : {}),
  ...(config.banyancode_goal_evaluator_model !== undefined
    ? { evaluatorModel: config.banyancode_goal_evaluator_model }
    : {}),
})

const describe = (goal: Goal.State | null): string => {
  if (goal === null) return "No goal is set."
  const status = goal.status === "active" ? "Goal active" : goal.status === "paused" ? "Goal paused" : "Goal achieved"
  return [`${status}: ${goal.objective}`, goal.reason].filter(Boolean).join("\n")
}

export const makeGoalTool = (ctx: Context): Tool.Info<typeof Input, typeof Output> => {
  // The goal plugin publishes Standard-Schema definitions; the plugin RPC
  // domain accepts any `Rpc.Definition`, so this is the same typed client the
  // built-in `/goal` command uses.
  const goals = ctx.rpc(Goal.Definition)
  const read = (sessionID: Tool.Context["sessionID"]) => goals.get({ sessionID })

  const run = (sessionID: Tool.Context["sessionID"], text: string) =>
    ctx.session.command({ sessionID, name: "goal", text })

  const next = (goal: Goal.State | null) => ({ output: { ok: true, goal }, content: describe(goal) })

  return {
    name: GOAL_TOOL,
    description:
      "Manage the goal loop for the current session. `set` starts a goal with a condition; `status` reads it; `list` lists this session's goal; `pause` / `resume` / `cancel` control it; `record_review` records a reviewer verdict (pass | fail | blocked), and once the configured round budget runs out the goal pauses with `max iterations reached`; `complete` ends the loop as achieved; `block` stops the loop with a reason (the goal pauses and can be resumed). One goal per session. `reviewID` and `goalID` are accepted for compatibility.",
    input: Input,
    output: Output,
    options: { permission: GOAL_TOOL },
    execute: (input, context) =>
      Effect.gen(function* () {
        yield* ctx.permission.assert({
          action: GOAL_TOOL,
          resources: ["*"],
          save: ["*"],
          metadata: input,
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.messageID, id: context.id },
        })

        if (input.action === "set") {
          const condition = (input.condition ?? "").trim()
          if (condition.length === 0) {
            return { output: { ok: false, message: "condition is required for set" }, content: "condition is required for set" }
          }
          yield* run(context.sessionID, condition)
          return next(yield* read(context.sessionID))
        }
        if (input.action === "cancel") {
          yield* run(context.sessionID, "clear")
          return next(yield* read(context.sessionID))
        }
        if (input.action === "pause" || input.action === "resume") {
          yield* run(context.sessionID, input.action)
          return next(yield* read(context.sessionID))
        }

        const goal = yield* read(context.sessionID)
        if (input.action === "list") {
          const items = goal === null ? [] : [goal]
          return { output: { ok: true, goal, message: JSON.stringify(items) }, content: JSON.stringify(items, null, 2) }
        }
        if (input.goalID !== undefined && goal !== null && input.goalID !== goal.id) {
          return { output: { ok: false, goal, message: `unknown goal: ${input.goalID}` }, content: `unknown goal: ${input.goalID}` }
        }
        if (input.action === "record_review") {
          if (input.verdict === undefined) {
            return { output: { ok: false, message: "verdict is required for record_review" }, content: "verdict is required for record_review" }
          }
          if (goal === null) {
            return { output: { ok: false, message: "no goal for this session" }, content: "no goal for this session" }
          }
          const reviewed = yield* goals.review({
            sessionID: context.sessionID,
            verdict: input.verdict,
            reason: input.reason ?? "",
          })
          const capped = reviewed?.status === "paused" && reviewed.reason === "max iterations reached"
          return {
            output: {
              ok: true,
              goal: reviewed,
              ...(capped ? { loopEnded: true, message: "max iterations reached" } : {}),
            },
            content: describe(reviewed),
          }
        }
        if (input.action === "complete") {
          const settled = yield* goals.settle({
            sessionID: context.sessionID,
            status: "complete",
            reason: input.reason ?? "",
          })
          if (settled === null) {
            return { output: { ok: false, message: "no goal for this session" }, content: "no goal for this session" }
          }
          return next(settled)
        }
        if (input.action === "block") {
          if (!input.reason) {
            return { output: { ok: false, message: "reason is required for block" }, content: "reason is required for block" }
          }
          const settled = yield* goals.settle({
            sessionID: context.sessionID,
            status: "paused",
            reason: input.reason,
          })
          if (settled === null) {
            return { output: { ok: false, message: "no goal for this session" }, content: "no goal for this session" }
          }
          return next(settled)
        }

        return next(goal)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            output: { ok: false, message: `goal tool failed: ${String(cause)}` },
            content: `goal tool failed: ${String(cause)}`,
          }),
        ),
      ),
  }
}
