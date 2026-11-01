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
 * it drives the command (`ctx.session.command`) and reads the state through
 * the goal RPC (`opencode.goal.get`). That gives the model set/status/list/
 * pause/resume/cancel without a second source of truth.
 *
 * Not portable from v1: `record_review` / `complete` / `block` (v1 kept review
 * records and let the orchestrator end the loop; v2's loop ends on its own
 * reviewer verdict), and `banyancode_max_goal_iterations` (v2's `maxRounds` is
 * fixed inside the goal plugin and has no seam).
 */

export const GOAL_TOOL = "goal"

const Actions = ["set", "status", "list", "pause", "resume", "cancel"] as const

export const Input = Schema.Struct({
  action: Schema.Literals(Actions),
  condition: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan.GoalToolInput" })

export type Input = typeof Input.Type

export const Output = Schema.Struct({
  ok: Schema.Boolean,
  goal: Schema.optional(Schema.NullOr(Schema.Unknown)),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan.GoalToolOutput" })

export type Output = typeof Output.Type

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

  return {
    name: GOAL_TOOL,
    description:
      "Manage the goal loop for the current session (v2 native goal mode). `set` starts a goal with a condition; `status` reads it; `list` lists this session's goal; `pause` / `resume` / `cancel` control it. One goal per session. The goal reviewer decides when the loop is done, so there is no manual complete/block action.",
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
          const goal = yield* read(context.sessionID)
          return { output: { ok: true, goal }, content: describe(goal) }
        }
        if (input.action === "cancel") {
          yield* run(context.sessionID, "clear")
          const goal = yield* read(context.sessionID)
          return { output: { ok: true, goal }, content: describe(goal) }
        }
        if (input.action === "pause" || input.action === "resume") {
          yield* run(context.sessionID, input.action)
          const goal = yield* read(context.sessionID)
          return { output: { ok: true, goal }, content: describe(goal) }
        }

        const goal = yield* read(context.sessionID)
        if (input.action === "list") {
          const items = goal === null ? [] : [goal]
          return { output: { ok: true, goal, message: JSON.stringify(items) }, content: JSON.stringify(items, null, 2) }
        }
        return { output: { ok: true, goal }, content: describe(goal) }
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
