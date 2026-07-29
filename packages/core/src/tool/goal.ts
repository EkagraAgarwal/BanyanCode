export * as GoalTool from "./goal"

import { ToolFailure } from "@opencode-ai/llm"
import { Banyan } from "../banyancode"
import { GoalConflictError } from "../banyancode/goal-service"
import type { GoalReviewVerdict } from "../banyancode/goal-payload"
import { Effect, Layer, Option, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "goal"

export const Action = Schema.Literals([
  "set",
  "status",
  "list",
  "record_review",
  "complete",
  "block",
  "cancel",
])

export const Input = Schema.Struct({
  action: Action,
  condition: Schema.optional(Schema.String),
  planPath: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Literals(["low", "normal", "high"])),
  goalID: Schema.optional(Schema.String),
  reviewID: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.Literals(["pass", "fail", "blocked"])),
  reason: Schema.optional(Schema.String),
})

export const Output = Schema.Struct({
  result: Schema.Unknown,
})

const resolveGoalID = (
  svc: Banyan.GoalServiceInterface,
  sessionID: string,
  providedID: string | undefined,
): Effect.Effect<string, ToolFailure> =>
  Effect.gen(function* () {
    if (providedID) return providedID
    const active = yield* svc.getActiveGoal(sessionID)
    if (!active) {
      return yield* new ToolFailure({ message: "no active goal for this session; pass goalID explicitly" })
    }
    return active.id
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Manage the active goal for the current session. The orchestrator drives a goal loop: set a goal with a condition, dispatch coder subagents to make progress, dispatch the reviewer subagent, then call `record_review` with the verdict (pass | fail | blocked). The loop terminates when you call `complete` (after a pass) or `block` (after exhausting retries). One active goal per session — `set` fails with a conflict error if another active goal exists; cancel it first.",
          input: Input,
          contract: { visibility: "public" },
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: typeof output.result === "string" ? output.result : JSON.stringify(output.result) },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const goalServiceOpt = yield* Effect.serviceOption(Banyan.GoalService)
              if (Option.isNone(goalServiceOpt)) {
                return { result: { error: "GoalService not available" } }
              }
              const svc = goalServiceOpt.value

              switch (input.action) {
                case "set": {
                  if (!input.condition) {
                    return yield* new ToolFailure({ message: "condition is required for set" })
                  }
                  const goal = yield* svc
                    .setGoal({
                      parentSessionID: context.sessionID,
                      condition: input.condition,
                      planPath: input.planPath ?? null,
                      priority: input.priority ?? null,
                    })
                    .pipe(
                      Effect.catchTag("Banyan/GoalConflictError", (e: GoalConflictError) =>
                        Effect.succeed({ error: "conflict", existingGoalID: e.existingGoalID } as const),
                      ),
                    )
                  return { result: { goal } }
                }
                case "status": {
                  const goal = yield* svc.getActiveGoal(context.sessionID)
                  return { result: goal ?? null }
                }
                case "list": {
                  const goals = yield* svc.listGoals(context.sessionID)
                  return { result: goals }
                }
                case "record_review": {
                  if (!input.reviewID) {
                    return yield* new ToolFailure({ message: "reviewID is required for record_review" })
                  }
                  if (!input.verdict) {
                    return yield* new ToolFailure({ message: "verdict is required for record_review" })
                  }
                  const id = yield* resolveGoalID(svc, context.sessionID, input.goalID)
                  const goal = yield* svc.recordReviewVerdict({
                    id,
                    reviewID: input.reviewID,
                    verdict: input.verdict as GoalReviewVerdict,
                    reason: input.reason ?? null,
                  })
                  return { result: goal }
                }
                case "complete": {
                  const id = yield* resolveGoalID(svc, context.sessionID, input.goalID)
                  const goal = yield* svc.achieve(id, input.reason)
                  return { result: goal }
                }
                case "block": {
                  if (!input.reason) {
                    return yield* new ToolFailure({ message: "reason is required for block" })
                  }
                  const id = yield* resolveGoalID(svc, context.sessionID, input.goalID)
                  const goal = yield* svc.block(id, input.reason)
                  return { result: goal }
                }
                case "cancel": {
                  const id = yield* resolveGoalID(svc, context.sessionID, input.goalID)
                  const goal = yield* svc.cancel(id, input.reason)
                  return { result: goal }
                }
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `goal tool failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)