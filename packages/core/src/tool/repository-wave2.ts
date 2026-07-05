import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import {
  CodegraphNodeSchema,
  type ArchitecturalSlice as ArchitecturalSliceT,
  type RepositoryContext as RepositoryContextT,
} from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as repositoryIntelligenceLayer } from "../banyancode/repository-intelligence"
import {
  formatArchitecturalSlice,
  formatNodesList,
  formatOwnership,
  formatRepositoryContext,
} from "./repository-format"
import { optionalNumber, optionalString } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name_query = "repository_query"
export const name_slice = "repository_slice"
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
})

const OwnershipResultSchema = Schema.Struct({
  owner: Schema.optional(Schema.String),
  count: Schema.Number,
})

const QueryInput = Schema.Struct({
  query: Schema.String,
  limit: optionalNumber,
  workspace: Schema.optional(WorkspaceContextSchema),
})

const ExplainInput = Schema.Struct({
  symbol: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
})

const ImpactInput = Schema.Struct({
  path: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
})

const TraceInput = Schema.Struct({
  symbol: Schema.String,
  depth: optionalNumber,
  workspace: Schema.optional(WorkspaceContextSchema),
})

const TestsInput = Schema.Struct({
  symbol: Schema.String,
})

const SymbolsInput = Schema.Struct({
  query: Schema.String,
  limit: optionalNumber,
})

const RelationshipsInput = Schema.Struct({
  nodeID: optionalString,
  path: optionalString,
  depth: optionalNumber,
})

const OwnershipInput = Schema.Struct({
  path: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
})

const QueryOutput = RepositoryContextSchema
const SliceOutput = ArchitecturalSliceSchema
const ExplainOutput = ArchitecturalSliceSchema
const ImpactOutput = ArchitecturalSliceSchema
const TraceOutput = ArchitecturalSliceSchema
const TestsOutput = Schema.Struct({ tests: CodegraphNodeSchemaArray })
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
  },
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
})

const sliceToOutput = (
  slc: ArchitecturalSliceT & {
    status?: "success" | "partial" | "failed"
    reason?: string
    recoveryHint?: string
    fallbackUsed?: boolean
    degraded?: boolean
  },
) => ({
  status: slc.status,
  reason: slc.reason,
  recoveryHint: slc.recoveryHint,
  fallbackUsed: slc.fallbackUsed,
  degraded: slc.degraded,
  summary: slc.summary,
  entrypoints: [...slc.entrypoints],
  importantSymbols: [...slc.importantSymbols],
  relatedTests: [...slc.relatedTests],
  relatedDocs: [...slc.relatedDocs],
  configs: [...slc.configs],
  routes: [...slc.routes],
  dependencies: slc.dependencies.map((d: { name: string; version?: string }) => ({
    name: d.name,
    ...(d.version ? { version: d.version } : {}),
  })),
})

export const InputQuery = QueryInput
export const InputSlice = QueryInput
export const InputExplain = ExplainInput
export const InputImpact = ImpactInput
export const InputTrace = TraceInput
export const InputTests = TestsInput
export const InputSymbols = SymbolsInput
export const InputRelationships = RelationshipsInput
export const InputOwnership = OwnershipInput

export const OutputQuery = QueryOutput
export const OutputSlice = SliceOutput
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

              const ws = workspaceFromInput(input)
              const ctx = yield* intel.query({
                query: input.query,
                ...(input.limit ? { limit: input.limit } : {}),
                ...(ws ? { workspace: ws } : {}),
              })
              return contextToOutput(ctx)
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_query failed" }))),
      }),
      [name_slice]: Tool.make({
        description:
          "Use when:\n" +
          "  composing an ArchitecturalSlice directly from a query (advanced — usually\n" +
          "  repository_explain already returns one).\n" +
          "Examples\n" +
          "  - \"Slice for `Effect.gen`\"\n" +
          "Returns\n" +
          "  ArchitecturalSlice { summary, entrypoints, importantSymbols, relatedTests,\n" +
          "    relatedDocs, configs, routes, dependencies }\n" +
          "Avoid when\n" +
          "  repository_explain already returns one — prefer that.\n" +
          "Visibility: advanced (eventually retire; absorbed into repository_explain).",
        contract: { visibility: "advanced" },
        input: InputSlice,
        output: OutputSlice,
        toModelOutput: ({ output }) => [{ type: "text", text: formatArchitecturalSlice(output) }],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_slice,
            input,
            (output) =>
              `entrypoints=${output.entrypoints.length} symbols=${output.importantSymbols.length} tests=${output.relatedTests.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_slice,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const ctx = yield* intel.query({ query: input.query, ...(input.limit ? { limit: input.limit } : {}) })
              const slc = yield* intel.slice(ctx)
              return sliceToOutput(slc)
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repository_slice failed" }))),
      }),
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

              const ws = workspaceFromInput(input)
              const slc = yield* intel.explain({
                symbol: input.symbol,
                ...(ws ? { workspace: ws } : {}),
              })
              return sliceToOutput(slc)
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
        contract: { visibility: "advanced" },
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

              const ws = workspaceFromInput(input)
              const slc = yield* intel.impact({
                path: input.path,
                ...(ws ? { workspace: ws } : {}),
              })
              return sliceToOutput(slc)
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

              const ws = workspaceFromInput(input)
              const slc = yield* intel.trace({
                symbol: input.symbol,
                ...(input.depth !== undefined ? { depth: input.depth } : {}),
                ...(ws ? { workspace: ws } : {}),
              })
              return sliceToOutput(slc)
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

              const tests = yield* intel.tests({ symbol: input.symbol })
              return { tests: [...tests] }
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
).pipe(Layer.provide(repositoryIntelligenceLayer))

export * as RepositoryWave2 from "./repository-wave2"
