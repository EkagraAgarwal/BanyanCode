import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { optionalBoolean, optionalNumber, optionalString } from "../codegraph/tools/schema.js"
import { computeBlastRadius } from "./blast-radius.js"
import type { CodeFindGraph } from "./code-find.js"
import { computeCodeFind, computeImpactEdges, renderCodeFind } from "./code-find.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { makeEditPlanner } from "./edit-planner.js"
import { formatArchitecturalSlice, formatNodesList, formatOwnership, formatRepositoryContext } from "./format.js"
import { computeOutline, computeRepoFiles } from "./outline.js"
import { computePreflight } from "./preflight.js"
import { resolveFileByPath, resolveGraphTarget } from "./resolve.js"
import { computeSafeRename, RenamePlanError } from "./safe-rename.js"
import { countStaleFilesFor, isStale } from "./staleness.js"
import type { Interface as Intelligence } from "./service.js"
import {
  ArchitecturalSliceSchema,
  BlastRadiusOutput,
  CODE_FIND_INTENTS,
  CodeFindOutput,
  EditPlanSchema,
  GraphMetaSchema,
  GraphNodeSchema,
  OutlineSchema,
  PreflightOutput,
  RepoFileSchema,
  RepositoryContextSchema,
  SafeRenameOutput,
  TestDerivation,
  WorkspaceContextSchema,
  type GraphMeta,
} from "./types.js"

/**
 * LLM-facing repository intelligence tools.
 *
 * Five ids total: `code_find` (symbol location + traversal + search),
 * `repo` (architectural/repository reads), `change_check` (preflight,
 * blast-radius counts, edit planning), `safe_rename` and `codegraph` (index
 * lifecycle, registered by the codegraph workstream). Every op forwards to the
 * existing service function; the tool layer only validates input and renders
 * model-facing text.
 */

export const NAMES = {
  codeFind: "code_find",
  repo: "repo",
  changeCheck: "change_check",
  safeRename: "safe_rename",
} as const

export interface ToolDeps {
  readonly ctx: Context
  readonly port: CodegraphPort
  readonly intel: Intelligence
  /** Search + structural services. Absent in the in-memory test ports. */
  readonly graph?: CodeFindGraph
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
    ? `${perFile.staleFiles} file(s) changed since index; run codegraph op=build`
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

const NodeSchema = GraphNodeSchema

// ── code_find ───────────────────────────────────────────────────────────────

export const CodeFindToolInput = Schema.Struct({
  intent: Schema.Literals([...CODE_FIND_INTENTS]).annotate({
    description:
      "definition locates a symbol; usages returns its definitions plus incoming calls/references; callers/references/dependents traverse it; implementations/overrides are structural; symbols lists name matches; search is scored fuzzy/BM25; find_file locates a file.",
  }),
  target: Schema.String.annotate({
    description: "Symbol name (e.g. 'MemoryRepo.update'), file name, or node ID.",
  }),
  path: optionalString.annotate({
    description: "Optional file filter (substring) for implementations/overrides.",
  }),
  include: optionalString.annotate({
    description: 'Glob over indexed paths to narrow results (for example "*.ts"), standing in for grep\'s include.',
  }),
  limit: optionalNumber.annotate({ description: "Max results. Defaults to 50." }),
  includeKeywordFallback: optionalBoolean.annotate({
    description: "Fall back to substring matching when the exact symbol is absent. Defaults to true.",
  }),
})

const RepoOp = Schema.Literals([
  "query",
  "explain",
  "impact",
  "trace",
  "tests",
  "relationships",
  "ownership",
  "slice",
  "structural",
  "outline",
  "files",
])

const StructuralKind = Schema.Literals(["recursive", "async", "http_routes"])

export const RepoToolInput = Schema.Struct({
  op: RepoOp.annotate({
    description:
      "query semantic search; explain architecture of a symbol; impact of a file path (path) or graph target (target/nodeID); trace dependencies; tests; relationships; ownership; slice; structural queries (kind=recursive|async|http_routes); outline a file (path); files glob (pattern).",
  }),
  query: optionalString.annotate({ description: "Free-text query (query)." }),
  symbol: optionalString.annotate({ description: "Symbol name (explain, trace, tests, slice)." }),
  path: optionalString.annotate({
    description: "File path (impact, relationships, ownership, outline) or file filter (structural, files).",
  }),
  nodeID: optionalString.annotate({ description: "Graph node ID (impact, relationships)." }),
  target: optionalString.annotate({ description: "Symbol name or node ID (impact graph form)." }),
  kind: Schema.optional(StructuralKind).annotate({ description: "Structural query kind (structural)." }),
  pattern: optionalString.annotate({ description: "Glob over indexed paths, e.g. 'src/**/*.ts' (files)." }),
  language: optionalString.annotate({ description: "Language filter (structural)." }),
  depth: optionalNumber.annotate({ description: "Traversal depth (trace, relationships)." }),
  limit: optionalNumber.annotate({ description: "Max results (query, trace, tests, structural, files)." }),
  workspace: Schema.optional(WorkspaceContextSchema).annotate({
    description: "Optional workspace focus (query, explain, impact, trace).",
  }),
})

const RepoTestsDetailed = Schema.Array(
  Schema.Struct({
    node: NodeSchema,
    derivation: TestDerivation,
  }),
)

const RepoOutput = Schema.Struct({
  op: Schema.String,
  context: Schema.optional(RepositoryContextSchema),
  slice: Schema.optional(ArchitecturalSliceSchema),
  tests: Schema.optional(Schema.Array(NodeSchema)),
  testsDetailed: Schema.optional(RepoTestsDetailed),
  notFound: Schema.optional(Schema.Boolean),
  nodes: Schema.optional(Schema.Array(NodeSchema)),
  owner: Schema.optional(Schema.String),
  count: Schema.optional(Schema.Number),
  dependents: Schema.optional(Schema.Array(NodeSchema)),
  transitive: Schema.optional(Schema.Array(NodeSchema)),
  outline: Schema.optional(OutlineSchema),
  files: Schema.optional(Schema.Array(RepoFileSchema)),
  total: Schema.optional(Schema.Number),
  truncated: Schema.optional(Schema.Boolean),
  resolved: Schema.optional(Schema.Boolean),
  resolvedNodeID: Schema.optional(Schema.String),
  resolutionDerivation: Schema.optional(Schema.String),
  meta: Schema.optional(GraphMetaSchema),
})

type RepoOutputType = typeof RepoOutput.Type

const ChangeCheckInput = Schema.Struct({
  op: Schema.Literals(["preflight", "blast_radius", "edit_plan"]).annotate({
    description:
      "preflight is the full decision report; blast_radius is counts only; edit_plan plans (phase=before) or verifies (phase=after) an edit.",
  }),
  target: Schema.String.annotate({ description: "Symbol name or node ID the edit targets." }),
  action: Schema.optional(Schema.Literals(["rename", "modify", "delete"])).annotate({
    description: "Planned edit kind (preflight). Defaults to modify.",
  }),
  depth: optionalNumber.annotate({ description: "Traversal depth (preflight depth / blast_radius maxDepth)." }),
  maxDepth: optionalNumber.annotate({ description: "Alias for depth (blast_radius)." }),
  phase: Schema.optional(Schema.Literals(["before", "after"])).annotate({
    description: "Plan before an edit or verify after it (edit_plan). Defaults to before.",
  }),
  changeKind: Schema.optional(Schema.Literals(["rename", "modify", "delete", "add"])).annotate({
    description: "Planned change kind (edit_plan). Defaults to modify.",
  }),
  filePath: optionalString.annotate({ description: "Target file path (edit_plan)." }),
  diff: optionalString.annotate({ description: "Applied diff (edit_plan phase=after)." }),
  root: optionalString.annotate({ description: "Workspace root override." }),
})

const ChangeCheckOutput = Schema.Struct({
  op: Schema.String,
  preflight: Schema.optional(PreflightOutput),
  blastRadius: Schema.optional(BlastRadiusOutput),
  plan: Schema.optional(EditPlanSchema),
  meta: Schema.optional(GraphMetaSchema),
})

const SafeRenameInput = Schema.Struct({
  symbol: Schema.String.annotate({ description: "Existing symbol, optionally qualified (e.g. 'MemoryRepo.put')." }),
  newName: Schema.String.annotate({ description: "New name; a bare name inherits the symbol's namespace." }),
  dryRun: Schema.Boolean.annotate({ description: "When true, edits are empty but preflight and risks still return." }),
  root: optionalString.annotate({ description: "Workspace root override." }),
})

const riskBlock = (risks: ReadonlyArray<{ severity: string; kind: string; message: string }>): string =>
  risks.length > 0
    ? risks.map((risk) => `- [${risk.severity.toUpperCase()}] ${risk.kind}: ${risk.message}`).join("\n")
    : "none."

const renderOutline = (outline: typeof OutlineSchema.Type): string => {
  const lines = [
    outline.header,
    `path=${outline.path}${outline.language ? ` language=${outline.language}` : ""}`,
    `symbols (${outline.symbols.length}${outline.truncated ? ", truncated" : ""}):`,
    ...outline.symbols.map(
      (symbol) =>
        `  ${symbol.kind} ${symbol.name} (${symbol.startLine}-${symbol.endLine})${symbol.signature ? ` ${symbol.signature}` : ""}`,
    ),
  ]
  return lines.join("\n")
}

const renderFiles = (output: { files: ReadonlyArray<{ path: string; language?: string }>; total: number; truncated: boolean }, pattern: string): string =>
  [
    `pattern="${pattern}" files=${output.files.length}${output.truncated ? ` (of ${output.total})` : ""}`,
    ...output.files.map((file) => `  ${file.path}${file.language ? ` [${file.language}]` : ""}`),
  ].join("\n")

export const buildTools = (deps: ToolDeps): readonly Tool.Info[] => {
  const planner = makeEditPlanner(deps.port)

  const codeFind: Tool.Info<typeof CodeFindToolInput, typeof CodeFindOutput> = {
    name: NAMES.codeFind,
    description:
      "Locate and traverse indexed code symbols. intent=definition (where is X), usages (definitions plus incoming calls/references), callers/references/dependents (graph traversal), implementations/overrides (structural), symbols (name lookup), search (scored fuzzy/BM25), find_file (file lookup). Read-only.",
    input: CodeFindToolInput,
    output: CodeFindOutput,
    options: { permission: NAMES.codeFind, codemode: true },
    execute: (input) =>
      Effect.gen(function* () {
        // Read-only: the tool-level `options.permission` action gates the call.
        const output = yield* computeCodeFind(
          deps.port,
          {
            intent: input.intent,
            target: input.target,
            ...(input.path === undefined ? {} : { path: input.path }),
            ...(input.include === undefined ? {} : { include: input.include }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            includeKeywordFallback: input.includeKeywordFallback ?? true,
          },
          deps.graph,
        )
        return { output, content: renderCodeFind(output) }
      }),
  }

  const repo: Tool.Info<typeof RepoToolInput, typeof RepoOutput> = {
    name: NAMES.repo,
    description:
      "Repository intelligence over the indexed graph. op=query (semantic entry point), explain (architecture slice), impact (file path or graph target), trace, tests, relationships, ownership, slice, structural (kind=recursive|async|http_routes), outline (one file's symbols + caller/import summary), files (glob over indexed paths). Read-only.",
    input: RepoToolInput,
    output: RepoOutput,
    options: { permission: NAMES.repo },
    execute: (input, context) =>
      Effect.gen(function* () {
        const op = input.op
        const resource =
          input.query ?? input.symbol ?? input.path ?? input.nodeID ?? input.target ?? input.pattern ?? op
        yield* permission(deps, { action: NAMES.repo, resources: [resource], metadata: input, context })

        const finish = (output: RepoOutputType, content: string) => ({ output, content })

        switch (op) {
          case "query": {
            if (!input.query) return yield* new Tool.Error({ message: "repo op=query requires query" })
            const ws = workspaceFromInput(input)
            const result = yield* deps.intel.query({
              query: input.query,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
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
            const output = {
              ...result,
              ...(message ? { reason: message, degraded: true } : {}),
              ...(message
                ? { diagnostics: [...(result.diagnostics ?? []), { kind: "stale-graph", message }] }
                : {}),
              ...withMeta(meta),
            }
            return finish({ op, context: output }, formatRepositoryContext(result))
          }
          case "explain": {
            if (!input.symbol) return yield* new Tool.Error({ message: "repo op=explain requires symbol" })
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
            return finish({ op, slice: output }, formatArchitecturalSlice(output))
          }
          case "impact": {
            // `path` keeps the architectural slice; `target`/`nodeID` keeps
            // the raw graph dependents (the graph-impact view).
            if (input.target !== undefined || input.nodeID !== undefined) {
              const result = yield* computeImpactEdges(deps.port, {
                ...(input.target === undefined ? {} : { target: input.target }),
                ...(input.nodeID === undefined ? {} : { nodeID: input.nodeID }),
                ...(input.depth === undefined ? {} : { maxDepth: input.depth }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              })
              return finish(
                {
                  op,
                  dependents: result.dependents,
                  transitive: result.transitive,
                  resolved: result.resolved ?? false,
                  ...(result.resolvedNodeID ? { resolvedNodeID: result.resolvedNodeID } : {}),
                  ...(result.resolutionDerivation ? { resolutionDerivation: result.resolutionDerivation } : {}),
                  ...(result.meta ? { meta: result.meta } : {}),
                },
                `${formatNodesList(result.dependents, "Direct dependents")}\n${formatNodesList(result.transitive, "Transitive dependents")}`,
              )
            }
            if (!input.path) return yield* new Tool.Error({ message: "repo op=impact requires path or target" })
            const ws = workspaceFromInput(input)
            const result = yield* deps.intel.impact({
              path: input.path,
              ...(ws ? { workspace: ws } : {}),
            })
            const meta = yield* deps.port.meta()
            return finish({ op, slice: result, ...withMeta(meta) }, formatArchitecturalSlice(result))
          }
          case "trace": {
            if (!input.symbol) return yield* new Tool.Error({ message: "repo op=trace requires symbol" })
            const ws = workspaceFromInput(input)
            const result = yield* deps.intel.trace({
              symbol: input.symbol,
              ...(input.depth === undefined ? {} : { depth: input.depth }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(ws ? { workspace: ws } : {}),
            })
            const meta = yield* deps.port.meta()
            return finish({ op, slice: result, ...withMeta(meta) }, formatArchitecturalSlice(result))
          }
          case "tests": {
            if (!input.symbol) return yield* new Tool.Error({ message: "repo op=tests requires symbol" })
            const resolution = yield* resolveGraphTarget(deps.port, { target: input.symbol })
            const meta = yield* deps.port.meta()
            const result = yield* deps.intel.tests({
              symbol: input.symbol,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            if (resolution._tag === "Miss") {
              return finish(
                { op, tests: [], testsDetailed: [], notFound: true, ...withMeta(meta) },
                formatNodesList([], "Tests"),
              )
            }
            const testsDetailed = result.tests
              .map((node) => ({ node, derivation: result.derivation }))
              .sort((a, b) => a.node.name.localeCompare(b.node.name))
            return finish(
              {
                op,
                tests: testsDetailed.map((entry) => entry.node),
                testsDetailed,
                notFound: result.notFound && testsDetailed.length === 0,
                ...withMeta(meta),
              },
              formatNodesList(testsDetailed.map((entry) => entry.node), "Tests"),
            )
          }
          case "relationships": {
            if (!input.nodeID && !input.path) {
              return finish({ op, nodes: [] }, formatNodesList([], "Related nodes"))
            }
            const nodes = yield* deps.intel.relationships({
              ...(input.nodeID ? { nodeID: input.nodeID } : {}),
              ...(input.path ? { path: input.path } : {}),
              ...(input.depth === undefined ? {} : { depth: input.depth }),
            })
            return finish({ op, nodes: [...nodes] }, formatNodesList(nodes, "Related nodes"))
          }
          case "ownership": {
            if (!input.path) return yield* new Tool.Error({ message: "repo op=ownership requires path" })
            const result = yield* deps.intel.findOwner({ path: input.path })
            return finish(
              { op, ...(result.owner !== undefined ? { owner: result.owner } : {}), count: result.count },
              formatOwnership(result.owner, result.count),
            )
          }
          case "slice": {
            if (!input.symbol) return yield* new Tool.Error({ message: "repo op=slice requires symbol" })
            const result = yield* deps.intel.explain({ symbol: input.symbol })
            const meta = yield* deps.port.meta()
            return finish({ op, slice: result, ...withMeta(meta) }, formatArchitecturalSlice(result))
          }
          case "structural": {
            if (!input.kind) return yield* new Tool.Error({ message: "repo op=structural requires kind" })
            const structural = deps.graph?.structural
            if (!structural) return finish({ op, nodes: [] }, formatNodesList([], "Structural results"))
            const filter = {
              ...(input.path ? { file: input.path } : {}),
              ...(input.language ? { language: input.language } : {}),
            }
            const nodes =
              input.kind === "recursive"
                ? yield* structural.findRecursiveFunctions(filter)
                : input.kind === "async"
                  ? yield* structural.findAsyncFunctions(filter)
                  : yield* structural.findHTTPRoutes(filter)
            const limited = input.limit === undefined ? nodes : nodes.slice(0, input.limit)
            return finish({ op, nodes: [...limited] }, formatNodesList(limited, "Structural results"))
          }
          case "outline": {
            if (!input.path) return yield* new Tool.Error({ message: "repo op=outline requires path" })
            const outline = yield* computeOutline(deps.port, {
              path: input.path,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            if (!outline) return yield* new Tool.Error({ message: `repo op=outline: ${input.path} is not indexed` })
            return finish({ op, outline }, renderOutline(outline))
          }
          case "files": {
            if (!input.pattern) return yield* new Tool.Error({ message: "repo op=files requires pattern" })
            const result = yield* computeRepoFiles(deps.port, {
              pattern: input.pattern,
              ...(input.path === undefined ? {} : { path: input.path }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            return finish({ op, files: result.files, total: result.total, truncated: result.truncated }, renderFiles(result, input.pattern))
          }
        }
      }),
  }

  const changeCheck: Tool.Info<typeof ChangeCheckInput, typeof ChangeCheckOutput> = {
    name: NAMES.changeCheck,
    description:
      "Check an edit before applying it. op=preflight (decision-ready caller/test/doc/route report), blast_radius (counts + risk), edit_plan (phase=before plan, phase=after re-verify). Read-only.",
    input: ChangeCheckInput,
    output: ChangeCheckOutput,
    options: { permission: NAMES.changeCheck },
    execute: (input, context) =>
      Effect.gen(function* () {
        yield* permission(deps, {
          action: NAMES.changeCheck,
          resources: [input.target],
          metadata: input,
          context,
        })
        if (input.op === "preflight") {
          const output = yield* computePreflight(
            { port: deps.port, intel: deps.intel },
            {
              action: input.action ?? "modify",
              target: input.target,
              ...(input.depth === undefined ? {} : { depth: input.depth }),
              ...(input.root === undefined ? {} : { root: input.root }),
            },
          )
          const riskBlockText =
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
            `risks:\n${riskBlockText}`,
          ]
          return {
            output: { op: input.op, preflight: output, ...(output.meta ? { meta: output.meta } : {}) },
            content: lines.join("\n"),
          }
        }
        if (input.op === "blast_radius") {
          const maxDepth = input.maxDepth ?? input.depth
          const output = yield* computeBlastRadius(
            { port: deps.port, intel: deps.intel },
            { target: input.target, ...(maxDepth === undefined ? {} : { maxDepth }) },
          )
          return {
            output: { op: input.op, blastRadius: output, ...(output.meta ? { meta: output.meta } : {}) },
            content:
              `directCallers=${output.directCallers} transitiveCallers=${output.transitiveCallers}\n` +
              `filesAffected=${output.filesAffected} testsToRun=${output.testsToRun}\n` +
              `risk=${output.risk}`,
          }
        }

        const phase = input.phase ?? "before"
        const plan =
          phase === "before"
            ? yield* Effect.gen(function* () {
                const preResolved = input.filePath
                  ? yield* Effect.gen(function* () {
                      const meta = yield* deps.port.meta()
                      const file = yield* resolveFileByPath(deps.port, input.filePath!, meta?.indexedRoot as string | undefined)
                      if (!file) return undefined
                      const resolution = yield* resolveGraphTarget(deps.port, {
                        target: input.target,
                        fileID: file.id,
                      })
                      return resolution._tag === "Ok" ? resolution.value.node : undefined
                    })
                  : undefined
                return yield* planner.planBeforeEdit({
                  targetSymbol: input.target,
                  changeKind: input.changeKind ?? "modify",
                  ...(input.filePath ? { filePath: input.filePath } : {}),
                  ...(input.root ? { root: input.root } : {}),
                  ...(preResolved ? { preResolvedTarget: preResolved } : {}),
                })
              })
            : yield* planner.planAfterEdit({
                targetSymbol: input.target,
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
        return {
          output: { op: input.op, plan, ...withMeta(meta) },
          content: [
            `**Steps to Execute:**\n${stepsBlock || "none."}`,
            `**Expected Impact:**\n${impactBlock}`,
            `**Risks Identified:**\n${riskBlock(plan.risks)}`,
          ].join("\n\n"),
        }
      }),
  }

  const safeRename: Tool.Info<typeof SafeRenameInput, typeof SafeRenameOutput> = {
    name: NAMES.safeRename,
    description:
      "Plan a symbol rename: per-site edits, tests to run, risks and the full preflight report. dryRun previews the blast radius without emitting edits. Requires edit permission.",
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
        const edits =
          output.edits.length > 0
            ? output.edits
                .map((edit, index) => `${index + 1}. ${edit.file}:${edit.line}  "${edit.oldText}" -> "${edit.newText}"`)
                .join("\n")
            : "none."
        return {
          output,
          content:
            `edits (${output.edits.length}):\n${edits}\n\n` +
            `testsToRun: ${output.testsToRun.length > 0 ? output.testsToRun.join(", ") : "none."}\n\n` +
            `risks:\n${riskBlock(output.risks)}`,
        }
      }),
  }

  return [codeFind, repo, changeCheck, safeRename]
}

