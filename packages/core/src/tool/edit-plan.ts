export * as EditPlanTool from "./edit-plan"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "edit_plan"

export const Input = Schema.Struct({
  phase: Schema.Literals(["before", "after"]).annotate({
    description:
      "REQUIRED. 'before' plans an upcoming edit; 'after' verifies the " +
      "blast radius of an edit that has already been applied.",
  }),
  targetSymbol: Schema.String.annotate({
    description:
      "REQUIRED. The symbol being edited (e.g. 'MemoryRepo.update').",
  }),
  changeKind: Schema.optional(Schema.Literals(["rename", "modify", "delete", "add"])).annotate({
    description:
      "Only meaningful when phase='before'. The kind of change being planned: " +
      "'rename', 'modify', 'delete', or 'add'. Drives which steps are emitted. " +
      "Defaults to 'modify' when omitted. Ignored when phase='after'.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description:
      "The file containing the target symbol. Optional — when omitted the " +
      "planner resolves it from the codegraph node for the resolved symbol. " +
      "Required for phase='before' with changeKind='add' (no existing node to look up).",
  }),
  diff: Schema.optional(Schema.String).annotate({
    description:
      "Only meaningful when phase='after'. The diff of the change just " +
      "applied. Ignored when phase='before'.",
  }),
  root: Schema.optional(Schema.String).annotate({
    description:
      "Workspace root for filesystem scans. Defaults to the current working " +
      "directory when omitted.",
  }),
}).annotate({
  description:
    "Plan an edit before applying it, or verify blast radius after. Returns " +
    "ordered steps the model should execute plus risk tags.",
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
          toModelOutput: ({ output }) => {
            const stepsBlock = output.plan.steps.map((s, i) => `${i + 1}. [${s.tool}] ${s.rationale} (args: ${JSON.stringify(s.args)})`).join("\n")
            const impactBlock = [
              `Direct Dependents: ${output.plan.expectedImpact.directDependents}${output.plan.expectedImpact.unreliable ? " (unreliable: " + output.plan.expectedImpact.unreliable + ")" : ""}`,
              `Transitive Dependents: ${output.plan.expectedImpact.transitiveDependents}${output.plan.expectedImpact.unreliable ? " (unreliable)" : ""}`,
              `Affected Tests to Run: ${output.plan.expectedImpact.testsToRun.length > 0 ? output.plan.expectedImpact.testsToRun.join(", ") : "none"}`,
            ].join("\n")
            const risksBlock = output.plan.risks.length > 0 
              ? output.plan.risks.map((r) => `- [${r.severity.toUpperCase()}] ${r.kind}: ${r.message}`).join("\n")
              : "none."
            
            const text = [
              `**Steps to Execute:**\n${stepsBlock || "none."}`,
              `**Expected Impact:**\n${impactBlock}`,
              `**Risks Identified:**\n${risksBlock}`
            ].join("\n\n")

            return [{ type: "text", text }]
          },
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
