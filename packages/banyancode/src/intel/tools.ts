import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { computeBlastRadius } from "./blast-radius.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { makeEditPlanner } from "./edit-planner.js"
import { formatArchitecturalSlice, formatNodesList, formatOwnership, formatRepositoryContext } from "./format.js"
import { computePreflight } from "./preflight.js"
import { resolveFileByPath, resolveGraphTarget } from "./resolve.js"
import { computeSafeRename, RenamePlanError } from "./safe-rename.js"
import type { Interface as Intelligence } from "./service.js"
import { countStaleFilesFor, isStale } from "./staleness.js"
import {
  ArchitecturalSliceSchema,
  BlastRadiusInput,
  BlastRadiusOutput,
  EditPlanInput,
  EditPlanOutput,
  ExplainInput,
  ImpactInput,
  OwnershipInput,
  OwnershipOutputSchema,
  PreflightInput,
  PreflightOutput,
  QueryInput,
  RelationshipsInput,
  RelationshipsOutputSchema,
  RepositoryContextSchema,
  SafeRenameInput,
  SafeRenameOutput,
  SymbolsInput,
  SymbolsOutputSchema,
  TestsInput,
  TestsOutputSchema,
  TraceInput,
  type GraphMeta,
} from "./types.js"

/**
 * LLM-facing tools for workstream 3c. IDs, parameters and descriptions are
 * copied verbatim from v1 so an agent sees the same surface after the
 * re-platform. The graph is read through `CodegraphPort`; readiness/auto-build
 * is owned by the codegraph workstream (`3a`) and is not triggered here.
 */

export const NAMES = {
  query: "repository_query",
  explain: "repository_explain",
  impact: "repository_impact",
  trace: "repository_trace",
  tests: "repository_tests",
  symbols: "repository_symbols",
  relationships: "repository_relationships",
  ownership: "repository_ownership",
  preflight: "preflight",
  blastRadius: "blast_radius",
  safeRename: "safe_rename",
  editPlan: "edit_plan",
} as const

export interface ToolDeps {
  readonly ctx: Context
  readonly port: CodegraphPort
  readonly intel: Intelligence
}

const permission = (
  deps: ToolDeps,
  input: { action: string; resources: readonly string[]; metadata: Record<string, unknown>; context: { sessionID: any; agent: any; messageID: any; id: any } },
) =>
  deps.ctx.permission.assert({
    action: input.action,
    resources: [...input.resources],
    save: ["*"],
    metadata: input.metadata,
    sessionID: input.context.sessionID,
    agent: input.context.agent,
    source: { type: "tool", messageID: input.context.messageID, id: input.context.id },
  })

const workspaceFromInput = (input: { workspace?: { worktree: string; focusDirs: readonly string[] } } | undefined) =>
  input?.workspace ? { worktree: input.workspace.worktree, focusDirs: [...input.workspace.focusDirs] } : undefined

const stalenessMessage = (result: { stale: boolean; reason?: string }, perFile: { stale: boolean; staleFiles: number }) =>
  perFile.stale
    ? `${perFile.staleFiles} file(s) changed since index; run /codegraph-build`
    : result.stale
      ? `${result.reason}; results may be incomplete`
      : undefined

const withMeta = (meta: GraphMeta | undefined) =>
  meta
    ? {
        meta: {
          graphBuiltAt: meta.graphBuiltAt,
          graphVersion: meta.graphVersion,
          graphCoverage: meta.graphCoverage,
          totalFiles: meta.totalFiles,
          totalNodes: meta.totalNodes,
          totalEdges: meta.totalEdges,
        },
      }
    : {}

export const buildTools = (deps: ToolDeps): readonly Tool.Info[] => {
  const planner = makeEditPlanner(deps.port)

  return [
    {
      name: NAMES.query,
      description:
        "Use when:\n" +
        "  semantic repository search — top-level entry point for repository questions.\n" +
        "Examples\n" +
        '  - "What does auth look like?"\n' +
        '  - "Find files about plugin loading"\n' +
        '  - "Effect.gen"\n' +
        "Returns\n" +
        "  { symbols, files, tests, docs, configs,\n" +
        "    graph: { nodes, edges },\n" +
        "    git: { recentCommits, ownership },\n" +
        "    ranking: { score, signals } }\n" +
        "Avoid when\n" +
        "  you already have a nodeID — use repository_trace or repository_impact.\n" +
        "After this, often: repository_symbols, repository_trace, repository_impact,\n" +
        "  codegraph_query — to drill in.\n" +
        "Before this: codegraph_build (if not built).",
      input: QueryInput,
      output: RepositoryContextSchema,
      options: { permission: NAMES.query },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, {
            action: NAMES.query,
            resources: [input.query],
            metadata: input,
            context,
          })
          const ws = workspaceFromInput(input)
          const result = yield* deps.intel.query({
            query: input.query,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(ws ? { workspace: ws } : {}),
          })
          const meta = yield* deps.port.meta()
          const stale = isStale(meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined)
          const perFile = yield* countStaleFilesFor(deps.port, [
            ...result.files.map((file) => file.id),
            ...result.symbols.map((node) => node.fileID),
            ...result.tests.map((node) => node.fileID),
          ])
          const message = result.reason ? undefined : stalenessMessage(stale, perFile)
          return {
            output: {
              ...result,
              ...(message ? { reason: message, degraded: true } : {}),
              ...(message
                ? { diagnostics: [...(result.diagnostics ?? []), { kind: "stale-graph", message }] }
                : {}),
              ...withMeta(meta),
            },
            content: formatRepositoryContext(result),
          }
        }),
    },
    {
      name: NAMES.explain,
      description:
        "Use when:\n" +
        "  explaining what a symbol does in the codebase.\n" +
        "Examples\n" +
        '  - "Explain `ToolCatalog`"\n' +
        '  - "Explain `MemoryRepo.update`"\n' +
        "Returns\n" +
        "  ArchitecturalSlice { summary, entrypoints, importantSymbols, relatedTests,\n" +
        "    relatedDocs, configs, routes, dependencies }\n" +
        "Avoid when\n" +
        "  you want raw callers — use codegraph_callers.\n" +
        "After this, often: repository_trace — to follow downstream links.\n" +
        "Before this: repository_query (if symbol ambiguous).",
      input: ExplainInput,
      output: ArchitecturalSliceSchema,
      options: { permission: NAMES.explain },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, {
            action: NAMES.explain,
            resources: [input.symbol],
            metadata: input,
            context,
          })
          const ws = workspaceFromInput(input)
          const result = yield* deps.intel.explain({
            symbol: input.symbol,
            ...(ws ? { workspace: ws } : {}),
          })
          const meta = yield* deps.port.meta()
          const stale = isStale(meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined)
          const perFile = yield* countStaleFilesFor(deps.port, [
            ...result.entrypoints.map((node) => node.fileID),
            ...result.importantSymbols.map((node) => node.fileID),
            ...result.relatedTests.map((node) => node.fileID),
            ...result.directCallers.map((node) => node.fileID),
            ...result.transitiveDependents.map((node) => node.fileID),
          ])
          const message = result.reason ? undefined : stalenessMessage(stale, perFile)
          const output = {
            ...result,
            ...(message ? { reason: message, degraded: true } : {}),
            ...(message ? { diagnostics: [...(result.diagnostics ?? []), { kind: "stale-graph", message }] } : {}),
            ...withMeta(meta),
          }
          return { output, content: formatArchitecturalSlice(output) }
        }),
    },
    {
      name: NAMES.impact,
      description:
        "Use when:\n" +
        "  what breaks if I edit a file by path (architectural blast radius).\n" +
        "Examples\n" +
        '  - "Impact of editing `codegraph-build-service.ts`"\n' +
        "Returns\n" +
        "  ArchitecturalSlice with affected symbols, files, tests, docs, configs.\n" +
        "Avoid when\n" +
        "  code-level impact — use codegraph_impact.\n" +
        "Visibility: advanced (use sparingly).\n" +
        "After this, often: edit_plan — to plan the change.\n" +
        "Before this: codegraph_build (if not built).",
      input: ImpactInput,
      output: ArchitecturalSliceSchema,
      options: { permission: NAMES.impact },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, { action: NAMES.impact, resources: [input.path], metadata: input, context })
          const ws = workspaceFromInput(input)
          const result = yield* deps.intel.impact({
            path: input.path,
            ...(ws ? { workspace: ws } : {}),
          })
          const meta = yield* deps.port.meta()
          return { output: { ...result, ...withMeta(meta) }, content: formatArchitecturalSlice(result) }
        }),
    },
    {
      name: NAMES.trace,
      description:
        "Use when:\n" +
        "  following imports / calls of a symbol through the repository.\n" +
        "Examples\n" +
        '  - "Trace `Effect.gen`"\n' +
        '  - "Where is `SessionTools.resolve` called from?"\n' +
        "Returns\n" +
        "  ArchitecturalSlice.\n" +
        "Avoid when\n" +
        "  you need an exact nodeID — repository_trace accepts a symbol name and\n" +
        "  resolves it internally.\n" +
        "After this, often: repository_impact — for the inverse direction.\n" +
        "Before this: codegraph_build (if not built).",
      input: TraceInput,
      output: ArchitecturalSliceSchema,
      options: { permission: NAMES.trace },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, { action: NAMES.trace, resources: [input.symbol], metadata: input, context })
          const ws = workspaceFromInput(input)
          const result = yield* deps.intel.trace({
            symbol: input.symbol,
            ...(input.depth !== undefined ? { depth: input.depth } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(ws ? { workspace: ws } : {}),
          })
          const meta = yield* deps.port.meta()
          return { output: { ...result, ...withMeta(meta) }, content: formatArchitecturalSlice(result) }
        }),
    },
    {
      name: NAMES.tests,
      description:
        "Use when:\n" +
        "  finding tests that reference a symbol.\n" +
        "Examples\n" +
        '  - "Tests for `parse`"\n' +
        '  - "Tests for `MemoryRepo.update`"\n' +
        "Returns\n" +
        "  { tests: CodegraphNode[] }\n" +
        "Avoid when\n" +
        "  you want the architectural slice — use repository_explain.\n" +
        "After this, often: read — to inspect a specific test.\n" +
        "Before this: codegraph_build (if not built).",
      input: TestsInput,
      output: TestsOutputSchema,
      options: { permission: NAMES.tests },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, { action: NAMES.tests, resources: [input.symbol], metadata: input, context })
          const resolution = yield* resolveGraphTarget(deps.port, { target: input.symbol })
          const meta = yield* deps.port.meta()
          const result = yield* deps.intel.tests({
            symbol: input.symbol,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          if (resolution._tag === "Miss") {
            return {
              output: { tests: [], testsDetailed: [], notFound: true, ...withMeta(meta) },
              content: formatNodesList([], "Tests"),
            }
          }
          const testsDetailed = result.tests
            .map((node) => ({ node, derivation: result.derivation }))
            .sort((a, b) => a.node.name.localeCompare(b.node.name))
          return {
            output: {
              tests: testsDetailed.map((entry) => entry.node),
              testsDetailed,
              notFound: result.notFound && testsDetailed.length === 0,
              ...withMeta(meta),
            },
            content: formatNodesList(testsDetailed.map((entry) => entry.node), "Tests"),
          }
        }),
    },
    {
      name: NAMES.symbols,
      description:
        "Use when:\n" +
        "  enumerating symbols matching a prefix / name (graph-level lookup).\n" +
        "Examples\n" +
        '  - "Symbols starting with `Database`"\n' +
        '  - "Symbol `Service`"\n' +
        "Returns\n" +
        "  { symbols: CodegraphNode[] }\n" +
        "Avoid when\n" +
        "  semantic repository question — use repository_query first.\n" +
        "Visibility: internal.",
      input: SymbolsInput,
      output: SymbolsOutputSchema,
      options: { permission: NAMES.symbols },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, { action: NAMES.symbols, resources: [input.query], metadata: input, context })
          const symbols = yield* deps.intel.symbols({
            query: input.query,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          })
          return { output: { symbols: [...symbols] }, content: formatNodesList(symbols, "Symbols") }
        }),
    },
    {
      name: NAMES.relationships,
      description:
        "Use when:\n" +
        "  walking the code graph to neighbors of an anchor node (graph-level).\n" +
        "Examples\n" +
        '  - "Neighbors of `MemoryRepo`"\n' +
        "Returns\n" +
        "  { nodes: CodegraphNode[] }\n" +
        "Avoid when\n" +
        "  semantic repository question — use repository_query first.\n" +
        "Visibility: internal.",
      input: RelationshipsInput,
      output: RelationshipsOutputSchema,
      options: { permission: NAMES.relationships },
      execute: (input, context) =>
        Effect.gen(function* () {
          if (!input.nodeID && !input.path) {
            return { output: { nodes: [] }, content: formatNodesList([], "Related nodes") }
          }
          yield* permission(deps, {
            action: NAMES.relationships,
            resources: [input.nodeID ?? input.path ?? ""],
            metadata: input,
            context,
          })
          const nodes = yield* deps.intel.relationships({
            ...(input.nodeID ? { nodeID: input.nodeID } : {}),
            ...(input.path ? { path: input.path } : {}),
            ...(input.depth !== undefined ? { depth: input.depth } : {}),
          })
          return { output: { nodes: [...nodes] }, content: formatNodesList(nodes, "Related nodes") }
        }),
    },
    {
      name: NAMES.ownership,
      description:
        "Use when:\n" +
        "  git blame / most-active author for a file.\n" +
        "Examples\n" +
        '  - "Who owns `codegraph-build-service.ts`?"\n' +
        "Returns\n" +
        "  { owner?, count }\n" +
        "Avoid when\n" +
        "  general code questions — use repository_query.\n" +
        "Visibility: internal.",
      input: OwnershipInput,
      output: OwnershipOutputSchema,
      options: { permission: NAMES.ownership },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, { action: NAMES.ownership, resources: [input.path], metadata: input, context })
          const result = yield* deps.intel.findOwner({
            path: input.path,
            ...(input.workspace?.worktree ? { cwd: input.workspace.worktree } : {}),
          })
          return {
            output: result.owner !== undefined ? { owner: result.owner, count: result.count } : { count: result.count },
            content: formatOwnership(result.owner, result.count),
          }
        }),
    },
    {
      name: NAMES.preflight,
      description:
        "Use when:\n" +
        "  the agent needs a single-call, decision-ready preflight report before editing a symbol —\n" +
        "  direct + transitive callers, tests, docs, configs, event bridges, HTTP routes,\n" +
        "  and risk verdicts.\n" +
        "Examples\n" +
        '  - "Preflight renaming MemoryRepo.put"\n' +
        '  - "Preflight modifying CodegraphBuildService.start"\n' +
        "Returns\n" +
        "  { target, directCallers, transitiveCallers, testsToRun, docsAffected,\n" +
        "    configsAffected, eventBridgesAffected, httpRoutesAffected, risks,\n" +
        "    derivation, generatedAt }\n" +
        "Avoid when\n" +
        "  only count is needed — use blast_radius instead.\n" +
        "After this, often: safe_rename (if action=rename), edit_plan.\n" +
        "Before this: codegraph_build (if not built), code_find (to check resolution).",
      input: PreflightInput,
      output: PreflightOutput,
      options: { permission: NAMES.preflight },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, {
            action: NAMES.preflight,
            resources: [input.target],
            metadata: input,
            context,
          })
          const output = yield* computePreflight(
            { port: deps.port, intel: deps.intel },
            input,
          )
          const riskBlock =
            output.risks.length > 0
              ? output.risks.map((risk) => `- [${risk.severity.toUpperCase()}] ${risk.kind}: ${risk.message}`).join("\n")
              : "none."
          const lines = [
            `target.resolved=${output.target.resolved}${output.target.node ? ` (${output.target.node.name})` : ""}`,
            `candidates=${output.target.candidates.length}`,
            `directCallers=${output.directCallers.length}`,
            `transitiveCallers=${output.transitiveCallers.length}`,
            `testsToRun=${output.testsToRun.length}`,
            `docsAffected=${output.docsAffected.length}`,
            `configsAffected=${output.configsAffected.length}`,
            `eventBridgesAffected=${output.eventBridgesAffected.length}`,
            `httpRoutesAffected=${output.httpRoutesAffected.length}`,
            `derivation=${output.derivation}`,
            `risks:\n${riskBlock}`,
          ]
          return { output, content: lines.join("\n") }
        }),
    },
    {
      name: NAMES.blastRadius,
      description:
        "Use when:\n" +
        "  a lightweight, count-only blast-radius read of a symbol — direct + transitive\n" +
        "  dependents, files touched, tests referencing the target by name/import OR\n" +
        "  living in the caller file set, and a single-word risk verdict.\n" +
        "Examples\n" +
        '  - "How risky is changing MemoryRepo?"\n' +
        '  - "Rough blast radius of Permission.evaluate"\n' +
        "Returns\n" +
        "  { directCallers, transitiveCallers, filesAffected, testsToRun, risk }\n" +
        "Avoid when\n" +
        "  you need the actual list of callers, files, or routes — use preflight instead.\n" +
        "After this, often: preflight — for the full report.\n" +
        "Before this: codegraph_build (if not built).",
      input: BlastRadiusInput,
      output: BlastRadiusOutput,
      options: { permission: NAMES.blastRadius },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, {
            action: NAMES.blastRadius,
            resources: [input.target],
            metadata: input,
            context,
          })
          const output = yield* computeBlastRadius({ port: deps.port, intel: deps.intel }, input)
          return {
            output,
            content:
              `directCallers=${output.directCallers} transitiveCallers=${output.transitiveCallers}\n` +
              `filesAffected=${output.filesAffected} testsToRun=${output.testsToRun}\n` +
              `risk=${output.risk}`,
          }
        }),
    },
    {
      name: NAMES.safeRename,
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
      input: SafeRenameInput,
      output: SafeRenameOutput,
      options: { permission: NAMES.safeRename },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, {
            action: NAMES.safeRename,
            resources: [input.symbol, input.newName],
            metadata: input,
            context,
          })
          const output = yield* computeSafeRename({ port: deps.port, intel: deps.intel, planner }, input).pipe(
            Effect.catchIf(
              (error): error is RenamePlanError => error instanceof RenamePlanError,
              (error) => Effect.fail(new Tool.Error({ message: error.message })),
            ),
          )
          const editBlock =
            output.edits.length > 0
              ? output.edits
                  .map((edit, index) => `${index + 1}. ${edit.file}:${edit.line}  "${edit.oldText}" -> "${edit.newText}"`)
                  .join("\n")
              : "none."
          const riskBlock =
            output.risks.length > 0
              ? output.risks.map((risk) => `- [${risk.severity.toUpperCase()}] ${risk.kind}: ${risk.message}`).join("\n")
              : "none."
          return {
            output,
            content:
              `edits (${output.edits.length}):\n${editBlock}\n\n` +
              `testsToRun: ${output.testsToRun.length > 0 ? output.testsToRun.join(", ") : "none."}\n\n` +
              `risks:\n${riskBlock}`,
          }
        }),
    },
    {
      name: NAMES.editPlan,
      description:
        "Use when:\n" +
        "  planning an edit before applying it (before) or verifying after-edit\n" +
        "  impact (after).\n" +
        "Examples\n" +
        '  - "Plan changing `parse` to `safeParse` in `codegraph-indexer.ts`"\n' +
        "Returns\n" +
        "  { plan: { steps, expectedImpact, risks } }\n" +
        "Avoid when\n" +
        "  you already know exactly what to change — apply directly with edit.\n" +
        "After this, often: edit (with permission) — to apply the steps.\n" +
        "Before this: codegraph_build (if not built), repository_impact (to size blast).",
      input: EditPlanInput,
      output: EditPlanOutput,
      options: { permission: NAMES.editPlan },
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission(deps, {
            action: NAMES.editPlan,
            resources: [input.targetSymbol],
            metadata: input,
            context,
          })
          const plan =
            input.phase === "before"
              ? yield* Effect.gen(function* () {
                  const preResolved = input.filePath
                    ? yield* Effect.gen(function* () {
                        const meta = yield* deps.port.meta()
                        const file = yield* resolveFileByPath(deps.port, input.filePath!, meta?.indexedRoot as string | undefined)
                        if (!file) return undefined
                        const resolution = yield* resolveGraphTarget(deps.port, {
                          target: input.targetSymbol,
                          fileID: file.id,
                        })
                        return resolution._tag === "Ok" ? resolution.value.node : undefined
                      })
                    : undefined
                  return yield* planner.planBeforeEdit({
                    targetSymbol: input.targetSymbol,
                    changeKind: input.changeKind ?? "modify",
                    ...(input.filePath ? { filePath: input.filePath } : {}),
                    ...(input.root ? { root: input.root } : {}),
                    ...(preResolved ? { preResolvedTarget: preResolved } : {}),
                  })
                })
              : yield* planner.planAfterEdit({
                  targetSymbol: input.targetSymbol,
                  ...(input.filePath ? { filePath: input.filePath } : {}),
                  ...(input.root ? { root: input.root } : {}),
                  ...(input.diff ? { diff: input.diff } : {}),
                })
          const meta = yield* deps.port.meta()
          const stepsBlock = plan.steps
            .map((step, index) => `${index + 1}. [${step.tool}] ${step.rationale} (args: ${JSON.stringify(step.args)})`)
            .join("\n")
          const impactBlock = [
            `Direct Dependents: ${plan.expectedImpact.directDependents}${plan.expectedImpact.unreliable ? " (unreliable: " + plan.expectedImpact.unreliable + ")" : ""}`,
            `Transitive Dependents: ${plan.expectedImpact.transitiveDependents}${plan.expectedImpact.unreliable ? " (unreliable)" : ""}`,
            `Affected Tests to Run: ${plan.expectedImpact.testsToRun.length > 0 ? plan.expectedImpact.testsToRun.join(", ") : "none"}`,
          ].join("\n")
          const risksBlock =
            plan.risks.length > 0
              ? plan.risks.map((risk) => `- [${risk.severity.toUpperCase()}] ${risk.kind}: ${risk.message}`).join("\n")
              : "none."
          return {
            output: { plan, ...withMeta(meta) },
            content: [
              `**Steps to Execute:**\n${stepsBlock || "none."}`,
              `**Expected Impact:**\n${impactBlock}`,
              `**Risks Identified:**\n${risksBlock}`,
            ].join("\n\n"),
          }
        }),
    },
  ]
}
