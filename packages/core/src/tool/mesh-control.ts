export * as MeshControlTool from "./mesh-control"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { MeshCoordinator } from "../banyancode/mesh-coordinator"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "mesh_control"

export const Action = Schema.Literals(["checkin", "steer", "kill", "plan_for"])
export const Input = Schema.Struct({
  action: Action,
  targetAgent: Schema.optional(Schema.String),
  instruction: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Literals(["low", "normal", "high"])),
  reason: Schema.optional(Schema.String),
  plan: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      steps: Schema.Array(
        Schema.Struct({
          content: Schema.String,
          status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
        }),
      ),
      exitCriteria: Schema.String,
    }),
  ),
})

export const Output = Schema.Struct({
  result: Schema.Unknown,
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const mesh = yield* MeshCoordinator.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Control subagents in the orchestrator's mesh. Actions: checkin (get status of all subagents), steer (inject an instruction into a subagent's current plan), kill (terminate a subagent gracefully), plan_for (hand a subagent its initial plan).",
          input: Input,
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

              switch (input.action) {
                case "checkin": {
                  const peers = yield* mesh.checkin(context.sessionID as any)
                  return { result: peers }
                }
                case "steer": {
                  if (!input.targetAgent) return yield* new ToolFailure({ message: "targetAgent is required for steer" })
                  if (!input.instruction) return yield* new ToolFailure({ message: "instruction is required for steer" })
                  yield* mesh.steer({
                    parentSessionID: context.sessionID as any,
                    targetAgent: input.targetAgent,
                    instruction: input.instruction,
                    priority: input.priority,
                  })
                  return { result: `steered ${input.targetAgent}` }
                }
                case "kill": {
                  if (!input.targetAgent) return yield* new ToolFailure({ message: "targetAgent is required for kill" })
                  if (!input.reason) return yield* new ToolFailure({ message: "reason is required for kill" })
                  yield* mesh.kill({
                    parentSessionID: context.sessionID as any,
                    targetAgent: input.targetAgent,
                    reason: input.reason,
                  })
                  return { result: `killed ${input.targetAgent}` }
                }
                case "plan_for": {
                  if (!input.targetAgent) return yield* new ToolFailure({ message: "targetAgent is required for plan_for" })
                  if (!input.plan) return yield* new ToolFailure({ message: "plan is required for plan_for" })
                  yield* mesh.planFor({
                    parentSessionID: context.sessionID as any,
                    targetAgent: input.targetAgent,
                    plan: {
                      title: input.plan.title,
                      steps: input.plan.steps.map((s: any) => ({ content: s.content, status: s.status })),
                      exitCriteria: input.plan.exitCriteria,
                    },
                  })
                  return { result: `planned for ${input.targetAgent}` }
                }
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `mesh_control failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)