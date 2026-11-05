import { Schema } from "effect"

/**
 * Graph row shapes and tool/RPC payload schemas for repository intelligence.
 *
 * These mirror the v1 declarations (`packages/core/src/banyancode/types.ts`
 * in v1; same field names, same node/edge kinds) so the ported tools return
 * exactly the payload the v1 tools returned. The codegraph workstream owns the storage tables; this
 * module never imports `src/codegraph`.
 */

export const NODE_KINDS = [
  "file",
  "function",
  "class",
  "method",
  "type",
  "variable",
  "test",
  "route",
  "config",
  "build",
  "package",
  "generated",
  "ci",
  "docker",
  "env",
  "doc",
] as const

export const EDGE_KINDS = [
  "imports",
  "calls",
  "extends",
  "references",
  "tested_by",
  "configured_by",
  "built_by",
  "mounts",
  "generated_from",
] as const

export type NodeKind = (typeof NODE_KINDS)[number]
export type EdgeKind = (typeof EDGE_KINDS)[number]

export type GraphFile = {
  readonly id: string
  readonly path: string
  readonly contentHash: string
  readonly language: string
  readonly indexedAt: number
  readonly sizeBytes?: number
  readonly mtimeMs?: number
}

export type GraphNode = {
  readonly id: string
  readonly fileID: string
  readonly kind: NodeKind
  readonly name: string
  readonly signature?: string
  readonly startLine: number
  readonly endLine: number
  readonly code?: string
  readonly isEntrypoint?: number
  readonly inDegree?: number
}

export type GraphEdge = {
  readonly id: string
  readonly fromNodeID: string
  readonly toNodeID: string
  readonly kind: EdgeKind
}

export type GraphMeta = {
  readonly graphBuiltAt: number
  readonly graphVersion: number
  readonly graphCoverage: number
  readonly totalFiles: number
  readonly totalNodes: number
  readonly totalEdges: number
  /** Root the graph was indexed from (DB meta row only; absent from wire payloads). */
  readonly indexedRoot?: string
}

export type WorkspaceContext = {
  readonly worktree: string
  readonly focusDirs: readonly string[]
}

export const GraphFileSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  contentHash: Schema.String,
  language: Schema.String,
  indexedAt: Schema.Number,
})

export const GraphNodeSchema = Schema.Struct({
  id: Schema.String,
  fileID: Schema.String,
  kind: Schema.Literals([...NODE_KINDS]),
  name: Schema.String,
  signature: Schema.optional(Schema.String),
  startLine: Schema.Number,
  endLine: Schema.Number,
  code: Schema.optional(Schema.String),
  isEntrypoint: Schema.optional(Schema.Number),
  inDegree: Schema.optional(Schema.Number),
})

export const GraphEdgeSchema = Schema.Struct({
  id: Schema.String,
  fromNodeID: Schema.String,
  toNodeID: Schema.String,
  kind: Schema.Literals([...EDGE_KINDS]),
})

export const GraphMetaSchema = Schema.Struct({
  graphBuiltAt: Schema.Number,
  graphVersion: Schema.Number,
  graphCoverage: Schema.Number,
  totalFiles: Schema.Number,
  totalNodes: Schema.Number,
  totalEdges: Schema.Number,
})

// Deliberately NOT annotated with `identifier`: an annotated struct reused as
// an HTTP/RPC body field corrupts single-element array decoding (AGENTS.md,
// `focusDirs: ["packages"]` regression).
export const WorkspaceContextSchema = Schema.Struct({
  worktree: Schema.String,
  focusDirs: Schema.Array(Schema.String),
})

export type WorkspaceContextInput = typeof WorkspaceContextSchema.Type

export const DiagnosticSchema = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
})

export type Diagnostic = typeof DiagnosticSchema.Type

export const RankingSchema = Schema.Struct({
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

export type Ranking = typeof RankingSchema.Type

export const ArchitecturalSliceSchema = Schema.Struct({
  status: Schema.optional(Schema.Literals(["success", "partial", "failed"])),
  reason: Schema.optional(Schema.String),
  recoveryHint: Schema.optional(Schema.String),
  fallbackUsed: Schema.optional(Schema.Boolean),
  degraded: Schema.optional(Schema.Boolean),
  summary: Schema.String,
  entrypoints: Schema.Array(GraphNodeSchema),
  importantSymbols: Schema.Array(GraphNodeSchema),
  relatedTests: Schema.Array(GraphNodeSchema),
  relatedDocs: Schema.Array(GraphFileSchema),
  configs: Schema.Array(GraphFileSchema),
  routes: Schema.Array(GraphNodeSchema),
  dependencies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.optional(Schema.String),
    }),
  ),
  directCallers: Schema.Array(GraphNodeSchema),
  transitiveDependents: Schema.Array(GraphNodeSchema),
  moreAvailable: Schema.optional(
    Schema.Struct({
      callers: Schema.optional(Schema.Number),
      dependents: Schema.optional(Schema.Number),
    }),
  ),
  diagnostics: Schema.optional(Schema.Array(DiagnosticSchema)),
})

export type ArchitecturalSlice = typeof ArchitecturalSliceSchema.Type

export const RepositoryContextSchema = Schema.Struct({
  status: Schema.optional(Schema.Literals(["success", "partial", "failed"])),
  reason: Schema.optional(Schema.String),
  recoveryHint: Schema.optional(Schema.String),
  fallbackUsed: Schema.optional(Schema.Boolean),
  degraded: Schema.optional(Schema.Boolean),
  query: Schema.String,
  symbols: Schema.Array(GraphNodeSchema),
  files: Schema.Array(GraphFileSchema),
  graph: Schema.Struct({
    nodes: Schema.Array(GraphNodeSchema),
    edges: Schema.Array(GraphEdgeSchema),
  }),
  tests: Schema.Array(GraphNodeSchema),
  docs: Schema.Array(GraphFileSchema),
  configs: Schema.Array(GraphFileSchema),
  git: Schema.Struct({
    recentCommits: Schema.Array(
      Schema.Struct({
        sha: Schema.String,
        subject: Schema.String,
        ts: Schema.Number,
      }),
    ),
    // v1 carried a `ReadonlyMap` internally; every wire surface (tools, HTTP)
    // converted it to entries. The entry array is the wire shape here.
    ownership: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        count: Schema.Number,
      }),
    ),
  }),
  workspace: Schema.optional(WorkspaceContextSchema),
  ranking: RankingSchema,
  diagnostics: Schema.optional(Schema.Array(DiagnosticSchema)),
  ambiguity: Schema.optional(
    Schema.Struct({
      total: Schema.Number,
      kept: Schema.Number,
    }),
  ),
  searchDerivation: Schema.optional(Schema.String),
})

export type RepositoryContext = typeof RepositoryContextSchema.Type

export const TestDerivation = Schema.Literals(["tested_by", "references", "import", "substring", "none"])
export type TestDerivation = typeof TestDerivation.Type

export const TestsOutputSchema = Schema.Struct({
  tests: Schema.Array(GraphNodeSchema),
  testsDetailed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        node: GraphNodeSchema,
        derivation: TestDerivation,
      }),
    ),
  ),
  notFound: Schema.Boolean,
  meta: Schema.optional(GraphMetaSchema),
})

export const SymbolsOutputSchema = Schema.Struct({
  symbols: Schema.Array(GraphNodeSchema),
})

export const RelationshipsOutputSchema = Schema.Struct({
  nodes: Schema.Array(GraphNodeSchema),
})

export const OwnershipOutputSchema = Schema.Struct({
  owner: Schema.optional(Schema.String),
  count: Schema.Number,
})

export const StalenessSchema = Schema.Struct({
  stale: Schema.Boolean,
  severity: Schema.optional(Schema.Literals(["med", "high"])),
  reason: Schema.optional(Schema.String),
})

// Preflight and the edit planner both feed this schema, so the union covers
// both vocabularies. The planner-only kinds are the ones v1 passed through as
// free-form strings.
export const RiskKind = Schema.Literals([
  "no-target",
  "many-callers",
  "no-tests",
  "touches-event-bus",
  "touches-http-routes",
  "stale-graph",
  "missing-tests",
  "external-caller",
  "broad-impact",
])

export const RiskSchema = Schema.Struct({
  kind: RiskKind,
  severity: Schema.Literals(["low", "medium", "high"]),
  message: Schema.String,
})

export type Risk = typeof RiskSchema.Type

export const PreflightInput = Schema.Struct({
  action: Schema.Literals(["rename", "modify", "delete"]),
  target: Schema.String,
  depth: Schema.optional(Schema.Number),
  root: Schema.optional(Schema.String),
})

export type PreflightInput = typeof PreflightInput.Type

export const EventBridgeSchema = Schema.Struct({
  name: Schema.String,
  file: Schema.String,
})

export const HttpRouteSchema = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  file: Schema.String,
})

export const PreflightOutput = Schema.Struct({
  target: Schema.Struct({
    resolved: Schema.Boolean,
    node: Schema.optional(GraphNodeSchema),
    candidates: Schema.Array(GraphNodeSchema),
  }),
  directCallers: Schema.Array(GraphNodeSchema),
  transitiveCallers: Schema.Array(GraphNodeSchema),
  testsToRun: Schema.Array(GraphFileSchema),
  docsAffected: Schema.Array(GraphFileSchema),
  configsAffected: Schema.Array(GraphFileSchema),
  eventBridgesAffected: Schema.Array(EventBridgeSchema),
  httpRoutesAffected: Schema.Array(HttpRouteSchema),
  risks: Schema.Array(RiskSchema),
  risk: Schema.Literals(["low", "medium", "high", "unknown"]),
  filePaths: Schema.Record(Schema.String, Schema.String),
  derivation: Schema.Literals(["regex-v1", "tree-sitter-v1", "runtime-v1"]),
  meta: Schema.optional(GraphMetaSchema),
  staleFiles: Schema.optional(Schema.Number),
  generatedAt: Schema.Number,
})

export type PreflightOutput = typeof PreflightOutput.Type

export const BlastRadiusInput = Schema.Struct({
  target: Schema.String,
  maxDepth: Schema.optional(Schema.Number),
})

export type BlastRadiusInput = typeof BlastRadiusInput.Type

export const BlastRadiusOutput = Schema.Struct({
  directCallers: Schema.Number,
  transitiveCallers: Schema.Number,
  filesAffected: Schema.Number,
  testsToRun: Schema.Number,
  risk: Schema.Literals(["low", "medium", "high", "unknown"]),
  graphStale: Schema.optional(Schema.Boolean),
  staleFiles: Schema.optional(Schema.Number),
  meta: Schema.optional(GraphMetaSchema),
  resolved: Schema.Boolean,
  resolutionDerivation: Schema.optional(Schema.String),
})

export type BlastRadiusOutput = typeof BlastRadiusOutput.Type

export const SafeRenameInput = Schema.Struct({
  symbol: Schema.String,
  newName: Schema.String,
  dryRun: Schema.Boolean,
  root: Schema.optional(Schema.String),
})

export type SafeRenameInput = typeof SafeRenameInput.Type

export const RenameEditSchema = Schema.Struct({
  file: Schema.String,
  oldText: Schema.String,
  newText: Schema.String,
  line: Schema.Number,
})

export const SafeRenameOutput = Schema.Struct({
  edits: Schema.Array(RenameEditSchema),
  testsToRun: Schema.Array(Schema.String),
  risks: Schema.Array(RiskSchema),
  preflight: Schema.Unknown,
  meta: Schema.optional(GraphMetaSchema),
})

export type SafeRenameOutput = typeof SafeRenameOutput.Type

const RiskSeverity = Schema.Literals(["low", "med", "high"])
const PlannerRiskKind = Schema.Literals([
  "stale-graph",
  "missing-tests",
  "external-caller",
  "no-target",
  "broad-impact",
])

export const EditPlanSchema = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      args: Schema.Record(Schema.String, Schema.Unknown),
      rationale: Schema.String,
    }),
  ),
  expectedImpact: Schema.Struct({
    directDependents: Schema.Number,
    transitiveDependents: Schema.Number,
    testsToRun: Schema.Array(Schema.String),
    unreliable: Schema.optional(Schema.String),
  }),
  risks: Schema.Array(
    Schema.Struct({
      kind: PlannerRiskKind,
      severity: RiskSeverity,
      message: Schema.String,
    }),
  ),
})

export type EditPlan = typeof EditPlanSchema.Type

export const EditPlanInput = Schema.Struct({
  phase: Schema.Literals(["before", "after"]),
  targetSymbol: Schema.String,
  changeKind: Schema.optional(Schema.Literals(["rename", "modify", "delete", "add"])),
  filePath: Schema.optional(Schema.String),
  diff: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
})

export type EditPlanInput = typeof EditPlanInput.Type

export const EditPlanOutput = Schema.Struct({
  plan: EditPlanSchema,
  meta: Schema.optional(GraphMetaSchema),
})

export const CODE_FIND_INTENTS = [
  "definition",
  "usages",
  "callers",
  "references",
  "dependents",
  "impact",
  "implementations",
  "overrides",
  "symbols",
  "search",
  "find_file",
] as const

export type CodeFindIntent = (typeof CODE_FIND_INTENTS)[number]

export const CodeFindInput = Schema.Struct({
  intent: Schema.Literals([...CODE_FIND_INTENTS]),
  target: Schema.String,
  path: Schema.optional(Schema.String),
  /** Glob over indexed paths; narrows results the same way grep's `include` does. */
  include: Schema.optional(Schema.String),
  includeKeywordFallback: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
})

export type CodeFindInput = typeof CodeFindInput.Type

export const SearchSignalsSchema = Schema.Struct({
  exact: Schema.optional(Schema.Boolean),
  prefix: Schema.optional(Schema.Boolean),
  camelCase: Schema.optional(Schema.Boolean),
  snake_case: Schema.optional(Schema.Boolean),
  bm25: Schema.optional(Schema.Number),
  fuzzy: Schema.optional(Schema.Number),
  qualified: Schema.optional(Schema.Boolean),
  graph: Schema.optional(Schema.Number),
})

export const CodeFindResultSchema = Schema.Struct({
  node: GraphNodeSchema,
  score: Schema.Number,
  signals: SearchSignalsSchema,
})

export const CodeFindOutput = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      node: GraphNodeSchema,
      derivation: Schema.String,
      path: Schema.optional(Schema.String),
    }),
  ),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
    }),
  ),
  results: Schema.optional(Schema.Array(CodeFindResultSchema)),
  meta: Schema.optional(GraphMetaSchema),
  intent: Schema.String,
  dispatchedTo: Schema.optional(Schema.String),
  staleFiles: Schema.optional(Schema.Number),
  _diagnostic: Schema.optional(
    Schema.Literals(["symbol-not-in-graph", "target-not-resolved", "no-edges-found", "empty-target", "stale-graph"]),
  ),
  resolvedNodeID: Schema.optional(Schema.String),
  resolvedDerivation: Schema.optional(Schema.String),
})

export type CodeFindOutput = typeof CodeFindOutput.Type

export const OutlineSymbolSchema = Schema.Struct({
  kind: Schema.Literals([...NODE_KINDS]),
  name: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  signature: Schema.optional(Schema.String),
})

export const OutlineSchema = Schema.Struct({
  path: Schema.String,
  fileID: Schema.String,
  language: Schema.optional(Schema.String),
  header: Schema.String,
  imports: Schema.Number,
  references: Schema.Number,
  callers: Schema.Number,
  dependents: Schema.Number,
  symbols: Schema.Array(OutlineSymbolSchema),
  truncated: Schema.Boolean,
  meta: Schema.optional(GraphMetaSchema),
})

export type Outline = typeof OutlineSchema.Type

export const RepoFileSchema = Schema.Struct({
  path: Schema.String,
  language: Schema.optional(Schema.String),
})

export const QueryInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  workspace: Schema.optional(WorkspaceContextSchema),
})

export const ExplainInput = Schema.Struct({
  symbol: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
})

export const ImpactInput = Schema.Struct({
  path: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
})

export const TraceInput = Schema.Struct({
  symbol: Schema.String,
  depth: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  workspace: Schema.optional(WorkspaceContextSchema),
})

export const TestsInput = Schema.Struct({
  symbol: Schema.String,
  limit: Schema.optional(Schema.Number),
})

export const SymbolsInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
})

export const RelationshipsInput = Schema.Struct({
  nodeID: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
})

export const OwnershipInput = Schema.Struct({
  path: Schema.String,
  workspace: Schema.optional(WorkspaceContextSchema),
})

export const ArchitecturalSliceQuery = Schema.Struct({
  focus: Schema.String,
})
