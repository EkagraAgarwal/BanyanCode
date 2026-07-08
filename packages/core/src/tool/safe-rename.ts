export * as SafeRenameTool from "./safe-rename"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../banyancode/codegraph-analyzer"
import type { Interface as RepositoryIntelligenceInterface } from "../banyancode/repository-intelligence/service"
import type { Interface as EditPlannerInterface } from "../banyancode/edit-planner"
import type { Interface as PermissionV2Interface } from "../permission"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as editPlannerLayer } from "../banyancode/edit-planner"
import { computePreflight } from "./preflight"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "safe_rename"

const RenameEditSchema = Schema.Struct({
  file: Schema.String,
  oldText: Schema.String,
  newText: Schema.String,
  line: Schema.Number,
})

const RenameRiskSchema = Schema.Struct({
  kind: Schema.String,
  severity: Schema.String,
  message: Schema.String,
})

export const Input = Schema.Struct({
  symbol: Schema.String.annotate({
    description:
      "REQUIRED. The qualified symbol name to rename (e.g. 'Permission.ask'). " +
      "Must be findable in the code graph.",
  }),
  newName: Schema.String.annotate({
    description:
      "REQUIRED. The new qualified name (e.g. 'Permission.request'). " +
      "If newName has no dot, the namespace is inherited from symbol.",
  }),
  dryRun: Schema.Boolean.annotate({
    description:
      "REQUIRED. When true, the tool returns the preflight, test list, and " +
      "risk report but emits zero edits — useful for previewing blast radius " +
      "before committing. When false, emits edits[] alongside the same plan.",
  }),
  root: Schema.optional(Schema.String).annotate({
    description:
      "Workspace root for filesystem scans. Defaults to the current working " +
      "directory when omitted.",
  }),
}).annotate({
  description:
    "Plan a symbol rename: list every call-site edit, the test files to " +
    "re-run, and the risk tags. The tool never writes files — apply the " +
    "returned edits with the edit tool.",
})

export const Output = Schema.Struct({
  edits: Schema.Array(RenameEditSchema),
  testsToRun: Schema.Array(Schema.String),
  risks: Schema.Array(RenameRiskSchema),
  preflight: Schema.Unknown,
})

function splitQualified(name: string): { root: string; leaf: string } | undefined {
  const parts = name.split(".")
  if (parts.length < 2) return undefined
  const leaf = parts.pop()!
  const root = parts.join(".")
  return { root, leaf }
}

const resolveNewName = (
  oldSymbol: string,
  newName: string,
): { namespace: string; leaf: string } | undefined => {
  if (newName.includes(".")) {
    const parts = newName.split(".")
    const leaf = parts.pop()!
    const namespace = parts.join(".")
    if (namespace.length === 0) return undefined
    return { namespace, leaf }
  }
  const oldParts = oldSymbol.split(".")
  const oldLeaf = oldParts.pop()
  if (!oldLeaf || oldParts.length === 0) return undefined
  return { namespace: oldParts.join("."), leaf: newName }
}

/**
 * Returns a specific failure reason + message for the cases where
 * `resolveNewName` can't infer a namespace. The two common shapes the user
 * hits are:
 *   - both bare:    symbol=Foo, newName=bar            → can't infer ns
 *   - bad qualified newName: symbol=Ns.Foo, newName=.bar → empty ns
 */
function namespaceFailureReason(input: { symbol: string; newName: string }):
  | { kind: "both-bare"; message: string }
  | { kind: "bad-qualified-newname"; message: string } {
  const symbolBare = !input.symbol.includes(".")
  const newNameBare = !input.newName.includes(".")
  if (symbolBare && newNameBare) {
    return {
      kind: "both-bare",
      message:
        `safe_rename: cannot resolve namespace because both inputs are bare ` +
        `("symbol=${input.symbol}", "newName=${input.newName}"). ` +
        `Pass a qualified symbol like "Namespace.${input.symbol}" (or a qualified newName like "Namespace.${input.newName}") so the tool knows where the rename belongs.`,
    }
  }
  return {
    kind: "bad-qualified-newname",
    message:
      `safe_rename: cannot derive a namespace from newName="${input.newName}". ` +
      `newName must be a qualified name with a non-empty namespace, e.g. "Namespace.${input.newName.startsWith(".") ? input.newName.slice(1) : input.newName}".`,
  }
}

export const computeSafeRename = (
  deps: {
    readonly repo: CodegraphRepoInterface
    readonly analyzer: CodegraphAnalyzerInterface
    readonly intel: RepositoryIntelligenceInterface
    readonly planner: EditPlannerInterface
  },
  input: typeof Input.Type,
): Effect.Effect<typeof Output.Type, ToolFailure, never> =>
  Effect.gen(function* () {
    const split = resolveNewName(input.symbol, input.newName)
    if (!split) {
      const reason = namespaceFailureReason({ symbol: input.symbol, newName: input.newName })
      return yield* Effect.fail(new ToolFailure({ message: reason.message }))
    }

    const targetNodeResult = (yield* deps.intel.symbols({ query: input.symbol })) as Array<Banyan.CodegraphNode>
    const targetNode = targetNodeResult[0]
    const oldLeaf = input.symbol.split(".").pop() ?? input.symbol
    const newLeaf = split.leaf
    const newNamespace = split.namespace

    const callSiteFiles = new Map<string, { line: number }>()
    if (targetNode) {
      const impact = yield* deps.analyzer
        .impact({ nodeID: targetNode.id, function: targetNode.name })
        .pipe(
          Effect.catchTag("Banyan/SymbolNotFoundError", () =>
            Effect.succeed({ dependents: [] as Array<Banyan.CodegraphNode>, transitive: [] as Array<Banyan.CodegraphNode> }),
          ),
        )
      for (const dep of impact.dependents) {
        callSiteFiles.set(dep.fileID, { line: dep.startLine })
      }
    }

    const allFiles = yield* deps.repo.listAllFiles()
    const filePathByID = new Map(allFiles.map((f) => [f.id, f.path]))

    const edits: Array<typeof RenameEditSchema.Type> = []
    for (const [fileID, meta] of callSiteFiles) {
      const filePath = filePathByID.get(fileID)
      if (!filePath) continue
      edits.push({
        file: filePath,
        oldText: oldLeaf,
        newText: newLeaf,
        line: meta.line,
      })
    }

    const testPaths = new Set<string>()
    if (targetNode) {
      const tests = yield* deps.intel.tests({ symbol: targetNode.name })
      for (const t of tests.tests) {
        const f = allFiles.find((af) => af.id === t.fileID)
        if (f) testPaths.add(f.path)
      }
    }

    const filePathForTarget = targetNode ? filePathByID.get(targetNode.fileID) : undefined
    const plannerPlan = yield* deps.planner.planBeforeEdit({
      targetSymbol: input.symbol,
      changeKind: "rename",
      filePath: filePathForTarget,
      root: input.root,
    })

    const risksFromPlanner = plannerPlan.risks.map((r) => ({
      kind: r.kind,
      severity: r.severity,
      message: r.message,
    }))

    // Delegate to the real preflight so this tool's `preflight` field reflects
    // the same risks + callers + event bridges the standalone `preflight` tool
    // would have produced. Previously this built a stub object with empty
    // arrays, which made the description claim ("calls preflight internally")
    // a lie.
    const preflight = yield* computePreflight(
      { repo: deps.repo, analyzer: deps.analyzer, intel: deps.intel },
      { action: "rename", target: input.symbol, ...(input.root ? { root: input.root } : {}) },
    )

    // `dryRun` gates the edits output. The tool never writes files regardless,
    // but a dry-run caller wants the plan + risks without per-call-site edits
    // cluttering the model output.
    const isDryRun = input.dryRun === true
    const emittedEdits = isDryRun ? [] : edits

    return {
      edits: emittedEdits,
      testsToRun: Array.from(testPaths),
      risks: risksFromPlanner,
      preflight,
    }
  })

export const makeSafeRenameTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
  readonly intel: RepositoryIntelligenceInterface
  readonly planner: EditPlannerInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  the agent wants a list of edits required to safely rename a symbol, plus the\n" +
      "  tests it should run before declaring success.\n" +
      "Examples\n" +
      '  - "Rename MemoryRepo.put to MemoryRepo.set safely" (both qualified)\n' +
      '  - "Rename Foo.bar to baz safely" (bare newName, namespace inherited from Foo)\n' +
      '  - "Rename Foo.bar to Foo.baz safely" (qualified newName)\n' +
      "Returns\n" +
      "  { edits: [{ file, oldText, newText, line }], testsToRun: [filePath], risks,\n" +
      "    preflight: <full preflight output> }\n" +
      "Avoid when\n" +
      "  the rename is purely textual and obvious — use edit.\n" +
      "After this, often: edit (per generated edit, with permission).\n" +
      "Before this: preflight (this tool calls it internally).\n" +
      "Namespace inference: if newName has no dot, the namespace is inherited from symbol.\n" +
      "dryRun: when true, edits=[] but preflight + risks still returned; useful for\n" +
      "  previewing the blast radius without committing to a rename plan.",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => {
      const editBlock =
        output.edits.length > 0
          ? output.edits
              .map((e, i) => `${i + 1}. ${e.file}:${e.line}  "${e.oldText}" -> "${e.newText}"`)
              .join("\n")
          : "none."
      const testBlock = output.testsToRun.length > 0 ? output.testsToRun.join(", ") : "none."
      const riskBlock =
        output.risks.length > 0
          ? output.risks.map((r) => `- [${r.severity.toUpperCase()}] ${r.kind}: ${r.message}`).join("\n")
          : "none."
      return [
        {
          type: "text",
          text:
            `edits (${output.edits.length}):\n${editBlock}\n\n` +
            `testsToRun: ${testBlock}\n\n` +
            `risks:\n${riskBlock}`,
        },
      ]
    },
    execute: (input, context) =>
      traced(
        process.cwd(),
        context.sessionID,
        name,
        input,
        (output) => `edits=${output.edits.length} tests=${output.testsToRun.length} risks=${output.risks.length}`,
        Effect.gen(function* () {
          yield* deps.permission.assert({
            action: name,
            resources: [input.symbol, input.newName],
            save: ["*"],
            metadata: input,
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          return yield* computeSafeRename(
            {
              repo: deps.repo,
              analyzer: deps.analyzer,
              intel: deps.intel,
              planner: deps.planner,
            },
            input,
          )
        }),
      ).pipe(
        Effect.mapError((err) =>
          err instanceof ToolFailure ? err : new ToolFailure({ message: "safe_rename failed" }),
        ),
      ),
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer
    const intel = yield* Banyan.RepositoryIntelligence
    const planner = yield* Banyan.EditPlanner

    yield* tools
      .register({
        [name]: makeSafeRenameTool({
          permission: permission as PermissionV2Interface,
          repo: repo as CodegraphRepoInterface,
          analyzer: analyzer as CodegraphAnalyzerInterface,
          intel: intel as RepositoryIntelligenceInterface,
          planner: planner as EditPlannerInterface,
        }),
      })
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(editPlannerLayer))
