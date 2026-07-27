import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { Banyan, isStale } from "../banyancode"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema, GraphMeta, type ArchitecturalSlice as ArchitecturalSliceT,
  type RepositoryContext as RepositoryContextT,
} from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { resolveGraphTargetPure } from "../banyancode/symbol-resolver"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import {
  formatArchitecturalSlice,
  formatNodesList,
  formatOwnership,
  formatRepositoryContext,
} from "./repository-format"
import { optionalNumber, optionalString } from "./tool-schema"
import { staleInputFromMeta, toGraphMeta } from "./graph-meta"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name_query = "repository_query"
// repository_slice retired: repository_explain supersedes it
export const name_explain = "repository_explain"
export const name_impact = "repository_impact"
export const name_trace = "repository_trace"
export const name_tests = "repository_tests"
export const name_symbols = "repository_symbols"
export const name_relationships = "repository_relationships"
export const name_ownership = "repository_ownership"

const CodegraphNodeSchemaArray = Schema.Array(CodegraphNodeSchema)
const CodegraphEdgeSchema = Schema.Struct({
  id: Schema.String,
  fromNodeID: Schema.String,
  toNodeID: Schema.String,
  kind: Schema.Literals([
    "imports",
    "calls",
    "extends",
    "references",
    "tested_by",
    "configured_by",
    "built_by",
    "mounts",
    "generated_from",
  ]),
})
const CodegraphEdgeSchemaArray = Schema.Array(CodegraphEdgeSchema)

const CodegraphFileSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  contentHash: Schema.String,
  language: Schema.String,
  indexedAt: Schema.Number,
})

const WorkspaceContextSchema = Schema.Struct({
  worktree: Schema.String,
  focusDirs: Schema.Array(Schema.String),
})

const RankingSchema = Schema.Struct({
  score: Schema.Number,
  signals: Schema.Struct({
    exact: Schema.Number,
    symbol: Schema.Number,
    graph: Schema.Number,
    git: Schema.Number,
    workspace: Schema.Number,
  }),
  workspace: Schema.optional(WorkspaceContextSchema),
})

const ArchitecturalSliceSchema = Schema.Struct({
  status: Schema.optional(Schema.Literals(["success", "partial", "failed"])),
  reason: Schema.optional(Schema.String),
  recoveryHint: Schema.optional(Schema.String),
  fallbackUsed: Schema.optional(Schema.Boolean),
  degraded: Schema.optional(Schema.Boolean),
  summary: Schema.String,
  entrypoints: CodegraphNodeSchemaArray,
  directCallers: CodegraphNodeSchemaArray,
  transitiveDependents: CodegraphNodeSchemaArray,
  moreAvailable: Schema.optional(
    Schema.Struct({
      callers: Schema.optional(Schema.Number),
      dependents: Schema.optional(Schema.Number),
    }),
  ),
  importantSymbols: CodegraphNodeSchemaArray,
  relatedTests: CodegraphNodeSchemaArray,
  relatedDocs: Schema.Array(CodegraphFileSchema),
  configs: Schema.Array(CodegraphFileSchema),
  routes: CodegraphNodeSchemaArray,
  dependencies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.optional(Schema.String),
    }),
  ),
  diagnostics: Schema.optional(Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
    }),
  )),
  meta: Schema.optional(GraphMeta),
})

const RepositoryContextSchema = Schema.Struct({
  status: Schema.optional(Schema.Literals(["success", "partial", "failed"])),
  reason: Schema.optional(Schema.String),
  recoveryHint: Schema.optional(Schema.String),
  fallbackUsed: Schema.optional(Schema.Boolean),
  degraded: Schema.optional(Schema.Boolean),
  query: Schema.String,
  symbols: CodegraphNodeSchemaArray,
  files: Schema.Array(CodegraphFileSchema),
  graph: Schema.Struct({
    nodes: CodegraphNodeSchemaArray,
    edges: CodegraphEdgeSchemaArray,
  }),
  tests: CodegraphNodeSchemaArray,
  docs: Schema.Array(CodegraphFileSchema),
  configs: Schema.Array(CodegraphFileSchema),
  git: Schema.Struct({
    recentCommits: Schema.Array(
      Schema.Struct({
        sha: Schema.String,
        subject: Schema.String,
        ts: Schema.Number,
      }),
    ),
    ownership: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        count: Schema.Number,
      }),
    ),
  }),
  workspace: Schema.optional(WorkspaceContextSchema),
  ranking: RankingSchema,
  diagnostics: Schema.optional(Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      message: Schema.String,
    }),
  )),
  meta: Schema.optional(GraphMeta),
})

const OwnershipResultSchema = Schema.Struct({
  owner: Schema.optional(Schema.String),
  count: Schema.Number,
})

const QueryInput = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "REQUIRED. The term, concept, or feature to search for. Can be a " +
      "symbol name ('MemoryRepo'), a concept ('authentication'), or a " +
      "feature ('session recovery').",
  }),
  limit: optionalNumber.annotate({
    description:
      "Maximum number of results to return. Defaults to 50 when omitted. " +
      "Allowed range: 1-500.",
  }),
  workspace: Schema.optional(WorkspaceContextSchema).annotate({
    description:
      "Optional workspace scoping. When omitted, the tool searches the " +
      "currently indexed workspace.",
  }),
}).annotate({
  description:
    "Semantic repository search. Top-level entry point for high-level " +
    "questions about a codebase. Returns symbols, files, tests, docs, " +
    "configs, graph slices, and git ownership signals.",
})

const ExplainInput = Schema.Struct({
  symbol: Schema.String.annotate({
    description:
      "REQUIRED. The symbol to explain (e.g. 'MemoryRepo', " +
      "'Permission.ask'). The tool returns an architectural slice showing " +
      "entrypoints, important symbols, related tests/docs, and dependencies.",
  }),
  workspace: Schema.optional(WorkspaceContextSchema).annotate({
    description:
      "Optional workspace scoping. Defaults to the currently indexed " +
      "workspace when omitted.",
  }),
}).annotate({
  description:
    "Architectural slice for a single symbol: entrypoints, important " +
    "symbols, related tests/docs, dependencies.",
})

const ImpactInput = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "REQUIRED. The file path or feature name to analyze for impact " +
      "(e.g. 'packages/core/src/banyancode/memory-repo.ts').",
  }),
  workspace: Schema.optional(WorkspaceContextSchema).annotate({
    description: "Optional workspace scoping. Defaults to the current workspace.",
  }),
}).annotate({
  description:
    "Impact analysis rooted at a file or feature: which modules depend on " +
    "it and what blast radius a change would have.",
})

const TraceInput = Schema.Struct({
  symbol: Schema.String.annotate({
    description:
      "REQUIRED. The entrypoint or symbol to trace from " +
      "(e.g. 'Permission.ask', 'main').",
  }),
  depth: optionalNumber.annotate({
    description:
      "Maximum traversal depth. Defaults to 2 when omitted. Higher values " +
      "(e.g. 5) give wider traces; lower values stay focused.",
  }),
  limit: optionalNumber.annotate({
    description:
      "Maximum number of transitive dependents to surface. Defaults to 50 " +
      "when omitted. Allowed range: 1-1000.",
  }),
  workspace: Schema.optional(WorkspaceContextSchema).annotate({
    description: "Optional workspace scoping.",
  }),
}).annotate({
  description:
    "Semantic trace from a symbol outward: tests, docs, and edges in the " +
    "code graph, with configurable depth.",
})

const TestsInput = Schema.Struct({
  symbol: Schema.String.annotate({
    description:
      "REQUIRED. The symbol to find tests for (e.g. 'MemoryRepo.update').",
  }),
  limit: optionalNumber.annotate({
    description:
      "Maximum number of tests to return. Defaults to 50 when omitted. " +
      "Allowed range: 1-500.",
  }),
}).annotate({
  description:
    "List tests that reference or exercise a given symbol.",
})

const SymbolsInput = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "REQUIRED. Symbol name or substring to search for " +
      "(e.g. 'withCwd', 'Memory').",
  }),
  limit: optionalNumber.annotate({
    description:
      "Maximum number of symbols to return. Defaults to 50 when omitted.",
  }),
}).annotate({
  description:
    "List symbols matching a name or substring, in codegraph order.",
})

const RelationshipsInput = Schema.Struct({
  nodeID: optionalString.annotate({
    description:
      "The graph UUID of the node to trace from. Provide either nodeID " +
      "OR path — the tool will reject calls with neither.",
  }),
  path: optionalString.annotate({
    description:
      "The file path to trace from when nodeID is omitted.",
  }),
  depth: optionalNumber.annotate({
    description:
      "Maximum traversal depth. Defaults to 2 when omitted.",
  }),
}).annotate({
  description:
    "List nodes reachable from a given node or path within N hops in the " +
    "code graph.",
})

const OwnershipInput = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "REQUIRED. The file or directory path to find the git owner for " +
      "(e.g. 'packages/core/src/banyancode').",
  }),
  workspace: Schema.optional(WorkspaceContextSchema).annotate({
    description: "Optional workspace scoping.",
  }),
}).annotate({
  description:
    "Git ownership signal: which developer has touched the given path most.",
})

const QueryOutput = RepositoryContextSchema
const ExplainOutput = ArchitecturalSliceSchema
const ImpactOutput = ArchitecturalSliceSchema
const TraceOutput = ArchitecturalSliceSchema
const TestDerivationSchema = Schema.Literals(["tested_by", "references", "import", "substring", "none"])
const TestsOutput = Schema.Struct({
  tests: CodegraphNodeSchemaArray,
  testsDetailed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        node: CodegraphNodeSchema,
        derivation: TestDerivationSchema,
      }),
    ),
  ),
  notFound: Schema.Boolean,
  meta: Schema.optional(GraphMeta),
})
const SymbolsOutput = Schema.Struct({ symbols: CodegraphNodeSchemaArray })
const RelationshipsOutput = Schema.Struct({ nodes: CodegraphNodeSchemaArray })
const OwnershipOutput = OwnershipResultSchema

type WorkspaceInput = { workspace?: { worktree: string; focusDirs: readonly string[] } } | undefined

const workspaceFromInput = (input: WorkspaceInput) => {
  if (!input?.workspace) return undefined
  return { worktree: input.workspace.worktree, focusDirs: [...input.workspace.focusDirs] }
}

const ownershipRecordToArray = (
  ownership: ReadonlyMap<string, number> | undefined,
): Array<{ path: string; count: number }> => {
  if (!ownership) return []
  const out: Array<{ path: string; count: number }> = []
  for (const [path, count] of ownership) out.push({ path, count })
  return out
}

const contextToOutput = (
  ctx: RepositoryContextT & {
    status?: "success" | "partial" | "failed"
    reason?: string
    recoveryHint?: string
    fallbackUsed?: boolean
    degraded?: boolean
    diagnostics?: readonly { kind: string; message: string }[]
  },
  graphMeta?: ReturnType<typeof toGraphMeta>,
) => ({
  status: ctx.status,
  reason: ctx.reason,
  recoveryHint: ctx.recoveryHint,
  fallbackUsed: ctx.fallbackUsed,
  degraded: ctx.degraded,
  query: ctx.query,
  symbols: [...ctx.symbols],
  files: [...ctx.files],
  graph: {
    nodes: [...ctx.graph.nodes],
    edges: [...ctx.graph.edges],
  },
  tests: [...ctx.tests],
  docs: [...ctx.docs],
  configs: [...ctx.configs],
  git: {
    recentCommits: [...ctx.git.recentCommits],
    ownership: ownershipRecordToArray(ctx.git.ownership as unknown as ReadonlyMap<string, number>),
  },
  workspace: ctx.workspace
    ? { worktree: ctx.workspace.worktree, focusDirs: [...ctx.workspace.focusDirs] }
    : undefined,
  ranking: {
    score: ctx.ranking.score,
    signals: {
      exact: ctx.ranking.signals.exact,
      symbol: ctx.ranking.signals.symbol,
      graph: ctx.ranking.signals.graph,
      git: ctx.ranking.signals.git,
      workspace: ctx.ranking.signals.workspace,
    },
    ...(ctx.ranking.workspace
      ? {
          workspace: {
            worktree: ctx.ranking.workspace.worktree,
            focusDirs: [...ctx.ranking.workspace.focusDirs],
          },
        }
      : {}),
  },
  ...(ctx.diagnostics ? { diagnostics: [...ctx.diagnostics] } : {}),
  ...(graphMeta ? { meta: graphMeta } : {}),
})

const sliceToOutput = (
  slc: ArchitecturalSliceT & {
    status?: "success" | "partial" | "failed"
    reason?: string
    recoveryHint?: string
    fallbackUsed?: boolean
    degraded?: boolean
    diagnostics?: readonly { kind: string; message: string }[]
  },
  graphMeta?: ReturnType<typeof toGraphMeta>,
) => ({
  status: slc.status,
  reason: slc.reason,
  recoveryHint: slc.recoveryHint,
  fallbackUsed: slc.fallbackUsed,
  degraded: slc.degraded,
  summary: slc.summary,
  entrypoints: [...slc.entrypoints],
  directCallers: [...(slc.directCallers ?? [])],
  transitiveDependents: [...(slc.transitiveDependents ?? [])],
  ...(slc.moreAvailable
    ? {
        moreAvailable: {
          ...(slc.moreAvailable.callers !== undefined ? { callers: slc.moreAvailable.callers } : {}),
          ...(slc.moreAvailable.dependents !== undefined ? { dependents: slc.moreAvailable.dependents } : {}),
        },
      }
    : {}),
  importantSymbols: [...slc.importantSymbols],
  relatedTests: [...slc.relatedTests],
  relatedDocs: [...slc.relatedDocs],
  configs: [...slc.configs],
  routes: [...slc.routes],
  dependencies: slc.dependencies.map((d: { name: string; version?: string }) => ({
    name: d.name,
    ...(d.version ? { version: d.version } : {}),
  })),
  ...(slc.diagnostics ? { diagnostics: [...slc.diagnostics] } : {}),
  ...(graphMeta ? { meta: graphMeta } : {}),
})

export const InputQuery = QueryInput
// repository_slice retired — its input was the same as QueryInput
export const InputExplain = ExplainInput
export const InputImpact = ImpactInput
export const InputTrace = TraceInput
export const InputTests = TestsInput
export const InputSymbols = SymbolsInput
export const InputRelationships = RelationshipsInput
export const InputOwnership = OwnershipInput

export const OutputQuery = QueryOutput
// repository_slice retired — its output was ArchitecturalSliceSchema (same as ExplainOutput)
export const OutputExplain = ExplainOutput
export const OutputImpact = ImpactOutput
export const OutputTrace = TraceOutput
export const OutputTests = TestsOutput
export const OutputSymbols = SymbolsOutput
export const OutputRelationships = RelationshipsOutput
export const OutputOwnership = OwnershipOutput

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const intel = yield* Banyan.RepositoryIntelligence
    const repo = yield* Banyan.CodegraphRepo
    const readiness = yield* Banyan.CodegraphReadiness

    // Phase: auto-trigger a full or incremental codegraph build whenever a
    // graph-backed repository tool is invoked against an unbuilt or stale
    // graph. Dedupe is handled inside the readiness service per workspace
    // root. Git-only tools (e.g. repository_ownership) intentionally skip
    // this gate to avoid an expensive build for cheap git queries.
    const ensureGraphReady = (input: { readonly [key: string]: unknown }, toolLabel: string) =>
      Effect.gen(function* () {
        const ws = input.workspace as { worktree?: string } | undefined
        const rootHint = typeof ws?.worktree === "string" ? ws.worktree : undefined
        const resolvedRoot = rootHint ?? process.cwd()
        const ready = yield* readiness.ensureReady({ root: path.resolve(resolvedRoot) })
        if (ready.reason === "failed") {
          yield* Effect.logWarning(`${toolLabel}: readiness failed: ${ready.error ?? "unknown"}`)
        }
        return ready
      })

    yield* tools.register({
      [name_query]: Tool.make({
        description:
          "Use when:\n" +
          "  semantic repository search — top-level entry point for repository questions.\n" +
          "Examples\n" +
          "  - \"What does auth look like?\"\n" +
          "  - \"Find files about plugin loading\"\n" +
          "  - \"Effect.gen\"\n" +
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
        contract: { visibility: "public" },
        input: InputQuery,
        output: OutputQuery,
        toModelOutput: ({ output }) => [
          { type: "text", text: formatRepositoryContext(output) },
        ],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_query,
            input,
            (output) =>
              `symbols=${output.symbols.length} tests=${output.tests.length} docs=${output.docs.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_query,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              yield* ensureGraphReady(input, name_query)

              const ws = workspaceFromInput(input)
              const ctx = yield* intel.query({
                query: input.query,
                ...(input.limit ? { limit: input.limit } : {}),
                ...(ws ? { workspace: ws } : {}),
              })
              const metaRow = yield* repo.getMeta()
              const staleResult = isStale(staleInputFromMeta(metaRow))
              if (staleResult.stale && staleResult.reason && !ctx.reason) {
                ;(ctx as { reason?: string; degraded?: boolean }).reason = `${staleResult.reason}; results may be incomplete`
                ;(ctx as { reason?: string; degraded?: boolean }).degraded = true
              }
              return contextToOutput(ctx, toGraphMeta(metaRow))
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_query failed" }))),
      }),
      // repository_slice retired: repository_explain supersedes it
      [name_explain]: Tool.make({
        description:
          "Use when:\n" +
          "  explaining what a symbol does in the codebase.\n" +
          "Examples\n" +
          "  - \"Explain `ToolCatalog`\"\n" +
          "  - \"Explain `MemoryRepo.update`\"\n" +
          "Returns\n" +
          "  ArchitecturalSlice { summary, entrypoints, importantSymbols, relatedTests,\n" +
          "    relatedDocs, configs, routes, dependencies }\n" +
          "Avoid when\n" +
          "  you want raw callers — use codegraph_callers.\n" +
          "After this, often: repository_trace — to follow downstream links.\n" +
          "Before this: repository_query (if symbol ambiguous).",
        contract: { visibility: "public" },
        input: InputExplain,
        output: OutputExplain,
        toModelOutput: ({ output }) => [{ type: "text", text: formatArchitecturalSlice(output) }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_explain,
            input,
            (output) => `entrypoints=${output.entrypoints.length} symbols=${output.importantSymbols.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_explain,
                resources: [input.symbol],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              yield* ensureGraphReady(input, name_explain)

              const ws = workspaceFromInput(input)
              const slc = yield* intel.explain({
                symbol: input.symbol,
                ...(ws ? { workspace: ws } : {}),
              })
              const metaRow = yield* repo.getMeta()
              const staleResult = isStale(staleInputFromMeta(metaRow))
              if (staleResult.stale && staleResult.reason && !slc.reason) {
                ;(slc as { reason?: string; degraded?: boolean }).reason = `${staleResult.reason}; results may be incomplete`
                ;(slc as { reason?: string; degraded?: boolean }).degraded = true
              }
              return sliceToOutput(slc, toGraphMeta(metaRow))
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_explain failed" }))),
      }),
      [name_impact]: Tool.make({
        description:
          "Use when:\n" +
          "  what breaks if I edit a file by path (architectural blast radius).\n" +
          "Examples\n" +
          "  - \"Impact of editing `codegraph-build-service.ts`\"\n" +
          "Returns\n" +
          "  ArchitecturalSlice with affected symbols, files, tests, docs, configs.\n" +
          "Avoid when\n" +
          "  code-level impact — use codegraph_impact.\n" +
          "Visibility: advanced (use sparingly).\n" +
          "After this, often: edit_plan — to plan the change.\n" +
          "Before this: codegraph_build (if not built).",
        contract: { visibility: "public" },
        input: InputImpact,
        output: OutputImpact,
        toModelOutput: ({ output }) => [{ type: "text", text: formatArchitecturalSlice(output) }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_impact,
            input,
            (output) =>
              `symbols=${output.importantSymbols.length} entrypoints=${output.entrypoints.length} tests=${output.relatedTests.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_impact,
                resources: [input.path],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              yield* ensureGraphReady(input, name_impact)

              const ws = workspaceFromInput(input)
              const slc = yield* intel.impact({
                path: input.path,
                ...(ws ? { workspace: ws } : {}),
              })
              const metaRow = yield* repo.getMeta()
              return sliceToOutput(slc, toGraphMeta(metaRow))
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_impact failed" }))),
      }),
      [name_trace]: Tool.make({
        description:
          "Use when:\n" +
          "  following imports / calls of a symbol through the repository.\n" +
          "Examples\n" +
          "  - \"Trace `Effect.gen`\"\n" +
          "  - \"Where is `SessionTools.resolve` called from?\"\n" +
          "Returns\n" +
          "  ArchitecturalSlice.\n" +
          "Avoid when\n" +
          "  you need an exact nodeID — repository_trace accepts a symbol name and\n" +
          "  resolves it internally.\n" +
          "After this, often: repository_impact — for the inverse direction.\n" +
          "Before this: codegraph_build (if not built).",
        contract: { visibility: "public" },
        input: InputTrace,
        output: OutputTrace,
        toModelOutput: ({ output }) => [{ type: "text", text: formatArchitecturalSlice(output) }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_trace,
            input,
            (output) => `entrypoints=${output.entrypoints.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_trace,
                resources: [input.symbol],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              yield* ensureGraphReady(input, name_trace)

              const ws = workspaceFromInput(input)
              const slc = yield* intel.trace({
                symbol: input.symbol,
                ...(input.depth !== undefined ? { depth: input.depth } : {}),
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
                ...(ws ? { workspace: ws } : {}),
              })
              const metaRow = yield* repo.getMeta()
              return sliceToOutput(slc, toGraphMeta(metaRow))
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_trace failed" }))),
      }),
      [name_tests]: Tool.make({
        description:
          "Use when:\n" +
          "  finding tests that reference a symbol.\n" +
          "Examples\n" +
          "  - \"Tests for `parse`\"\n" +
          "  - \"Tests for `MemoryRepo.update`\"\n" +
          "Returns\n" +
          "  { tests: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  you want the architectural slice — use repository_explain.\n" +
          "After this, often: read — to inspect a specific test.\n" +
          "Before this: codegraph_build (if not built).",
        contract: { visibility: "public" },
        input: InputTests,
        output: OutputTests,
        toModelOutput: ({ output }) => [{ type: "text", text: formatNodesList(output.tests, "Tests") }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_tests,
            input,
            (output) => `tests=${output.tests.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_tests,
                resources: [input.symbol],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              yield* ensureGraphReady(input, name_tests)

              // Keep the resolver call so we can short-circuit on a hard
              // Miss (genuinely unknown symbol) and surface `notFound: true`
              // to the caller. We do NOT use the resolver to bucket tests
              // any more — `intel.tests` already does derivation ranking
              // (tested_by → references → import → substring) and is the
              // single source of truth. Previously a depth-1 BFS around the
              // resolved node's file was excluding valid tests (Issue #4).
              const resolved = yield* resolveGraphTargetPure(
                repo as CodegraphRepoInterface,
                { target: input.symbol },
              )

              const metaRow = yield* repo.getMeta()
              const graphMeta = toGraphMeta(metaRow)
              const tests = yield* intel.tests({ symbol: input.symbol, limit: input.limit })
              if (resolved._tag === "Miss") {
                return { tests: [], testsDetailed: [], notFound: true, ...(graphMeta ? { meta: graphMeta } : {}) }
              }

              const rank: Record<typeof tests.derivation, number> = {
                tested_by: 0,
                references: 1,
                import: 2,
                substring: 3,
                none: 4,
              }
              const limit = Math.max(1, Math.min(500, input.limit ?? 50))
              const testsDetailed = tests.tests
                .map((node) => ({ node, derivation: tests.derivation as typeof tests.derivation }))
                .sort((a, b) => rank[a.derivation] - rank[b.derivation] || a.node.name.localeCompare(b.node.name))
                .slice(0, limit)
              return {
                tests: testsDetailed.map((entry) => entry.node),
                testsDetailed,
                notFound: tests.notFound && testsDetailed.length === 0,
                ...(graphMeta ? { meta: graphMeta } : {}),
              }
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_tests failed" }))),
      }),
      [name_symbols]: Tool.make({
        description:
          "Use when:\n" +
          "  enumerating symbols matching a prefix / name (graph-level lookup).\n" +
          "Examples\n" +
          "  - \"Symbols starting with `Database`\"\n" +
          "  - \"Symbol `Service`\"\n" +
          "Returns\n" +
          "  { symbols: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  semantic repository question — use repository_query first.\n" +
          "Visibility: internal.",
        contract: { visibility: "internal" },
        input: InputSymbols,
        output: OutputSymbols,
        toModelOutput: ({ output }) => [{ type: "text", text: formatNodesList(output.symbols, "Symbols") }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_symbols,
            input,
            (output) => `symbols=${output.symbols.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_symbols,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              yield* ensureGraphReady(input, name_symbols)

              const symbols = yield* intel.symbols({
                query: input.query,
                ...(input.limit ? { limit: input.limit } : {}),
              })
              return { symbols: [...symbols] }
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_symbols failed" }))),
      }),
      [name_relationships]: Tool.make({
        description:
          "Use when:\n" +
          "  walking the code graph to neighbors of an anchor node (graph-level).\n" +
          "Examples\n" +
          "  - \"Neighbors of `MemoryRepo`\"\n" +
          "Returns\n" +
          "  { nodes: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  semantic repository question — use repository_query first.\n" +
          "Visibility: internal.",
        contract: { visibility: "internal" },
        input: InputRelationships,
        output: OutputRelationships,
        toModelOutput: ({ output }) => [{ type: "text", text: formatNodesList(output.nodes, "Related nodes") }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_relationships,
            input,
            (output) => `nodes=${output.nodes.length}`,
            Effect.gen(function* () {
              if (!input.nodeID && !input.path) {
                return { nodes: [] as Banyan.CodegraphNode[] }
              }
              yield* permission.assert({
                action: name_relationships,
                resources: [input.nodeID ?? input.path ?? ""],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              yield* ensureGraphReady(input, name_relationships)

              const nodes = yield* intel.relationships({
                ...(input.nodeID ? { nodeID: input.nodeID } : {}),
                ...(input.path ? { path: input.path } : {}),
                ...(input.depth !== undefined ? { depth: input.depth } : {}),
              })
              return { nodes: [...nodes] }
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_relationships failed" }))),
      }),
      [name_ownership]: Tool.make({
        description:
          "Use when:\n" +
          "  git blame / most-active author for a file.\n" +
          "Examples\n" +
          "  - \"Who owns `codegraph-build-service.ts`?\"\n" +
          "Returns\n" +
          "  { owner?, count }\n" +
          "Avoid when\n" +
          "  general code questions — use repository_query.\n" +
          "Visibility: internal.",
        contract: { visibility: "internal" },
        input: InputOwnership,
        output: OutputOwnership,
        toModelOutput: ({ output }) => [{ type: "text", text: formatOwnership(output.owner, output.count) }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_ownership,
            input,
            (output) => `owner=${output.owner ?? "unknown"} count=${output.count}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_ownership,
                resources: [input.path],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const owner = yield* intel.findOwner({
                path: input.path,
                ...(input.workspace?.worktree ? { cwd: input.workspace.worktree } : {}),
              })
              const out: { owner?: string; count: number } =
                owner.owner !== undefined ? { owner: owner.owner, count: owner.count } : { count: owner.count }
              return out
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_ownership failed" }))),
      }),
    })
  }),
)

export * as RepositoryWave2 from "./repository-wave2"
