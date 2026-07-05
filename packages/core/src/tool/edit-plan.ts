export * as EditPlanTool from "./edit-plan"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { optionalString } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "edit_plan"

export const Input = Schema.Struct({
  phase: Schema.Literals(["before", "after"]),
  targetSymbol: Schema.String,
  changeKind: Schema.optional(Schema.Literals(["rename", "modify", "delete", "add"])),
  filePath: optionalString,
  diff: optionalString,
  root: optionalString,
})

export const Output = Schema.Struct({
  plan: Banyan.EditPlan,
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const planner = yield* Banyan.EditPlanner

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Use when:\n" +
            "  planning an edit before applying it (before) or verifying after-edit\n" +
            "  impact (after).\n" +
            "Examples\n" +
            "  - \"Plan changing `parse` to `safeParse` in `codegraph-indexer.ts`\"\n" +
            "Returns\n" +
            "  { plan: { steps, expectedImpact, risks } }\n" +
            "Avoid when\n" +
            "  you already know exactly what to change — apply directly with edit.\n" +
            "After this, often: edit (with permission) — to apply the steps.\n" +
            "Before this: codegraph_build (if not built), repository_impact (to size blast).",
          contract: { visibility: "public" },
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `steps=${output.plan.steps.length} direct=${output.plan.expectedImpact.directDependents} transitive=${output.plan.expectedImpact.transitiveDependents} risks=${output.plan.risks.length}`,
            },
          ],
          execute: (input, context) => {
            return traced(
              process.cwd(),
              context.sessionID,
              name,
              input,
              (output) => `steps=${output.plan.steps.length} direct=${output.plan.expectedImpact.directDependents} transitive=${output.plan.expectedImpact.transitiveDependents} risks=${output.plan.risks.length}`,
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [input.targetSymbol],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const plan =
                  input.phase === "before"
                    ? yield* planner.planBeforeEdit({
                        targetSymbol: input.targetSymbol,
                        changeKind: input.changeKind ?? "modify",
                        filePath: input.filePath,
                        root: input.root,
                      })
                    : yield* planner.planAfterEdit({
                        targetSymbol: input.targetSymbol,
                        filePath: input.filePath,
                        root: input.root,
                        diff: input.diff,
                      })
                return { plan }
              }),
            ).pipe(
              Effect.mapError((err) => {
                if (err instanceof ToolFailure) return err
                return new ToolFailure({ message: `edit_plan failed` })
              }),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
