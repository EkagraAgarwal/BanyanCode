import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { CodegraphNodeSchema } from "@opencode-ai/core/banyancode/types"
import { described } from "./metadata"


const CodegraphEdgeKindLiterals = Schema.Literals([
  "imports",
  "calls",
  "extends",
  "references",
  "tested_by",
  "configured_by",
  "built_by",
  "mounts",
  "generated_from",
])

const CodegraphFileSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  contentHash: Schema.String,
  language: Schema.String,
  indexedAt: Schema.Number,
}).annotate({ identifier: "Banyan/CodegraphFile" })

const WorkspaceContextSchema = Schema.Struct({
  worktree: Schema.String,
  focusDirs: Schema.Array(Schema.String),
})

const RankingSignalsSchema = Schema.Struct({
  exact: Schema.Number,
  symbol: Schema.Number,
  graph: Schema.Number,
  git: Schema.Number,
  workspace: Schema.Number,
}).annotate({ identifier: "Banyan/RankingSignals" })

const TestResultDerivationSchema = Schema.Literals([
  "tested_by",
  "references",
  "import-binding",
  "substring-low-confidence",
]).annotate({ identifier: "Banyan/TestResultDerivation" })

const TestDerivationSchema = Schema.Literals([
  "tested_by",
  "references",
  "import-binding",
  "substring-low-confidence",
  "none",
]).annotate({ identifier: "Banyan/TestDerivation" })

const TestMatchSchema = Schema.Struct({
  node: CodegraphNodeSchema,
  derivation: TestResultDerivationSchema,
  confidence: Schema.Number,
}).annotate({ identifier: "Banyan/TestMatch" })

const TestMatchArraySchema = Schema.Array(TestMatchSchema)

const RankingSchema = Schema.Struct({
  score: Schema.Number,
  signals: RankingSignalsSchema,
  workspace: Schema.optional(WorkspaceContextSchema),
}).annotate({ identifier: "Banyan/Ranking" })

const ArchitecturalSliceSchema = Schema.Struct({
  status: Schema.optional(Schema.Literals(["success", "partial", "failed"])),
  reason: Schema.optional(Schema.String),
  recoveryHint: Schema.optional(Schema.String),
  fallbackUsed: Schema.optional(Schema.Boolean),
  degraded: Schema.optional(Schema.Boolean),
  summary: Schema.String,
  entrypoints: Schema.Array(CodegraphNodeSchema),
  importantSymbols: Schema.Array(CodegraphNodeSchema),
  relatedTests: Schema.Array(CodegraphNodeSchema),
  relatedTestsDetailed: Schema.optional(TestMatchArraySchema),
  relatedDocs: Schema.Array(CodegraphFileSchema),
  configs: Schema.Array(CodegraphFileSchema),
  routes: Schema.Array(CodegraphNodeSchema),
  dependencies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.optional(Schema.String),
    }),
  ),
  directCallers: Schema.Array(CodegraphNodeSchema),
  transitiveDependents: Schema.Array(CodegraphNodeSchema),
  diagnostics: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        message: Schema.String,
      }),
    ),
  ),
}).annotate({ identifier: "Banyan/ArchitecturalSlice" })

const CodegraphEdgeSchema = Schema.Struct({
  id: Schema.String,
  fromNodeID: Schema.String,
  toNodeID: Schema.String,
  kind: CodegraphEdgeKindLiterals,
}).annotate({ identifier: "Banyan/CodegraphEdge" })

const GitContextSchema = Schema.Struct({
  recentCommits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      subject: Schema.String,
      ts: Schema.Number,
    }),
  ),
  ownership: Schema.ReadonlyMap(Schema.String, Schema.Number),
}).annotate({ identifier: "Banyan/GitContext" })

const RepositoryContextSchema = Schema.Struct({
  query: Schema.String,
  symbols: Schema.Array(CodegraphNodeSchema),
  files: Schema.Array(CodegraphFileSchema),
  graph: Schema.Struct({
    nodes: Schema.Array(CodegraphNodeSchema),
    edges: Schema.Array(CodegraphEdgeSchema),
  }),
  tests: Schema.Array(CodegraphNodeSchema),
  testsDetailed: Schema.optional(TestMatchArraySchema),
  docs: Schema.Array(CodegraphFileSchema),
  configs: Schema.Array(CodegraphFileSchema),
  git: GitContextSchema,
  workspace: Schema.optional(WorkspaceContextSchema),
  diagnostics: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        message: Schema.String,
      }),
    ),
  ),
  ranking: RankingSchema,
  ambiguity: Schema.optional(
    Schema.Struct({
      total: Schema.Number,
      kept: Schema.Number,
    }),
  ),
  searchDerivation: Schema.optional(
    Schema.Literals([
      "tag-fallback",
      "name-exact",
      "qualified-split",
      "code-substring",
      "name-like",
      "fts-bm25",
      "node-id",
    ]),
  ),
}).annotate({ identifier: "Banyan/RepositoryContext" })

export const RepositoryResponseSchema = Schema.Struct({
  slice: ArchitecturalSliceSchema,
  context: RepositoryContextSchema,
}).annotate({ identifier: "Banyan/RepositoryResponse" })

export type RepositoryResponse = {
  readonly slice: typeof ArchitecturalSliceSchema.Type
  readonly context: typeof RepositoryContextSchema.Type
}

export const QueryInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  workspace: Schema.optional(WorkspaceContextSchema),
}).annotate({ identifier: "Banyan/QueryInput" })

export const ExplainInput = Schema.Struct({
  symbol: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
}).annotate({ identifier: "Banyan/ExplainInput" })

export const ImpactInput = Schema.Struct({
  path: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
}).annotate({ identifier: "Banyan/ImpactInput" })

export const TraceInput = Schema.Struct({
  symbol: Schema.String,
  depth: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  workspace: Schema.optional(WorkspaceContextSchema),
}).annotate({ identifier: "Banyan/TraceInput" })

export const TestsInput = Schema.Struct({
  symbol: Schema.String,
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/TestsInput" })

export const SymbolsInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/SymbolsInput" })

export const RelationshipsInput = Schema.Struct({
  nodeID: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/RelationshipsInput" })

export const OwnershipInput = Schema.Struct({
  path: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
}).annotate({ identifier: "Banyan/OwnershipInput" })

export const OwnershipResult = Schema.Struct({
  owner: Schema.optional(Schema.String),
  count: Schema.Number,
}).annotate({ identifier: "Banyan/OwnershipResult" })

export const TestsOutput = Schema.Struct({
  tests: Schema.Array(CodegraphNodeSchema),
  testsDetailed: Schema.optional(TestMatchArraySchema),
  derivation: TestDerivationSchema,
  notFound: Schema.Boolean,
  fallbackReason: Schema.optional(Schema.String),
  staleFiles: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan/TestsOutput" })

export const ArchitecturalSliceQuery = Schema.Struct({
  focus: Schema.String,
}).annotate({ identifier: "Banyan/ArchitecturalSliceQuery" })

export const REPOSITORY_INTEL_PREFIX = "/global/repository"

export const RepositoryIntelPaths = {
  query: `${REPOSITORY_INTEL_PREFIX}/query`,
  explain: `${REPOSITORY_INTEL_PREFIX}/explain`,
  impact: `${REPOSITORY_INTEL_PREFIX}/impact`,
  trace: `${REPOSITORY_INTEL_PREFIX}/trace`,
  tests: `${REPOSITORY_INTEL_PREFIX}/tests`,
  symbols: `${REPOSITORY_INTEL_PREFIX}/symbols`,
  relationships: `${REPOSITORY_INTEL_PREFIX}/relationships`,
  ownership: `${REPOSITORY_INTEL_PREFIX}/ownership`,
  architecturalSlice: `${REPOSITORY_INTEL_PREFIX}/architectural-slice`,
} as const

export const RepositoryIntelApi = HttpApi.make("repository-intel").add(
  HttpApiGroup.make("repository-intel")
    .add(
      HttpApiEndpoint.post("query", RepositoryIntelPaths.query, {
        payload: QueryInput,
        success: described(RepositoryResponseSchema, "Repository context and slice for query"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.query",
          summary: "Repository query",
          description:
            "Wave-2 unified repository query: returns both the raw RepositoryContext and the projected ArchitecturalSlice for a free-text query.",
        }),
      ),
      HttpApiEndpoint.post("explain", RepositoryIntelPaths.explain, {
        payload: ExplainInput,
        success: described(ArchitecturalSliceSchema, "Architectural slice for symbol"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.explain",
          summary: "Explain symbol",
          description: "Returns the ArchitecturalSlice describing how the given symbol works.",
        }),
      ),
      HttpApiEndpoint.post("impact", RepositoryIntelPaths.impact, {
        payload: ImpactInput,
        success: described(ArchitecturalSliceSchema, "Architectural slice for impact"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.impact",
          summary: "Estimate impact",
          description: "Returns the ArchitecturalSlice describing the impact of editing the given path.",
        }),
      ),
      HttpApiEndpoint.post("trace", RepositoryIntelPaths.trace, {
        payload: TraceInput,
        success: described(ArchitecturalSliceSchema, "Architectural slice for trace"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.trace",
          summary: "Trace execution",
          description: "Returns the ArchitecturalSlice tracing execution from a given symbol.",
        }),
      ),
      HttpApiEndpoint.post("tests", RepositoryIntelPaths.tests, {
        payload: TestsInput,
        success: described(TestsOutput, "Tests for symbol"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.tests",
          summary: "Find tests",
          description:
            "Returns test nodes covering the given symbol with per-result derivation and confidence. A substring-low-confidence match is a raw-code diagnostic, never a confirmed test hit.",
        }),
      ),
      HttpApiEndpoint.post("symbols", RepositoryIntelPaths.symbols, {
        payload: SymbolsInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Matching symbols"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.symbols",
          summary: "Search symbols",
          description: "Returns codegraph nodes matching the free-text query.",
        }),
      ),
      HttpApiEndpoint.post("relationships", RepositoryIntelPaths.relationships, {
        payload: RelationshipsInput,
        success: described(Schema.Array(CodegraphNodeSchema), "Related nodes"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.relationships",
          summary: "Node relationships",
          description: "Returns nodes related to the given nodeID up to the requested depth.",
        }),
      ),
      HttpApiEndpoint.post("ownership", RepositoryIntelPaths.ownership, {
        payload: OwnershipInput,
        success: described(OwnershipResult, "File ownership"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.ownership",
          summary: "File ownership",
          description: "Returns the primary owner for the given path plus commit count.",
        }),
      ),
      HttpApiEndpoint.get("architecturalSlice", RepositoryIntelPaths.architecturalSlice, {
        query: ArchitecturalSliceQuery,
        success: described(ArchitecturalSliceSchema, "Architectural slice for focus"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "repositoryIntel.architecturalSlice",
          summary: "Architectural slice",
          description: "Returns an ArchitecturalSlice explaining the symbol named by ?focus=...",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "repository-intel",
        description: "Wave-2 repository intelligence HTTP surface.",
      }),
    ),
)
