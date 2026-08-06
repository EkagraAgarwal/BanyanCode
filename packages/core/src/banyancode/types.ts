import { Schema } from "effect"
import type { ResolutionDerivation } from "./symbol-resolver"

export type MemoryEntry = {
  id: string
  key: string
  value: unknown
  context?: string
  tags: string[]
  scope: "global" | "session"
  sessionID?: string
  createdAt: number
  expiresAt?: number
  agentID?: string
  version: number
  updatedAt: number
  namespace?: string
  // Phase 1a: denormalized columns read from the envelope. Optional so
  // legacy rows from pre-Phase-1 DBs don't fail type checks; the repo fills
  // them on every write.
  kind?: string
  title?: string
  body?: string
  status?: string
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  id: Schema.String,
}) {}

export class StaleWriteError extends Schema.TaggedErrorClass<StaleWriteError>()("StaleWriteError", {
  id: Schema.String,
  expectedVersion: Schema.Number,
  currentVersion: Schema.Number,
}) {}

export type CodegraphFile = {
  id: string
  path: string
  contentHash: string
  language: string
  indexedAt: number
  sizeBytes?: number
  mtimeMs?: number
}

export type CodegraphNodeKind =
  | "file"
  | "function"
  | "class"
  | "method"
  | "type"
  | "variable"
  | "test"
  | "route"
  | "config"
  | "build"
  | "package"
  | "generated"
  | "ci"
  | "docker"
  | "env"
  | "doc"

export type CodegraphEdgeKind =
  | "imports"
  | "calls"
  | "extends"
  | "references"
  | "tested_by"
  | "configured_by"
  | "built_by"
  | "mounts"
  | "generated_from"

/**
 * How a derived edge was produced. Ordered roughly high-to-low confidence;
 * consumers should prefer `binding-resolved` / `service-tag` edges over
 * `heuristic-name` ones and report when only heuristic edges exist.
 */
export type CodegraphEdgeDerivation =
  | "binding-resolved"
  | "service-tag"
  | "same-file"
  | "heuristic-name"

/** 0-100 scale; higher is more trustworthy. See `CodegraphEdgeDerivation`. */
export const EDGE_CONFIDENCE: Record<CodegraphEdgeDerivation, number> = {
  "binding-resolved": 100,
  "service-tag": 80,
  "same-file": 60,
  "heuristic-name": 40,
}

export type CodegraphNode = {
  id: string
  fileID: string
  kind: CodegraphNodeKind
  name: string
  signature?: string
  startLine: number
  endLine: number
  code?: string
  derivation?: CodegraphDerivation
  /**
   * Phase 3: 1 if the indexer classified this node as a likely entrypoint
   * (route handler, CLI command, etc), 0 otherwise. Set at index time by
   * the entrypoint heuristic in codegraph-indexer.ts.
   */
  isEntrypoint?: 0 | 1
  /**
   * Phase 3: number of incoming edges. Pre-computed by the indexer's final
   * `repo.recomputeInDegree()` so the trace ranker can score transitive
   * dependents without an O(N) COUNT per candidate.
   */
  inDegree?: number
}

export type CodegraphDerivation =
  | "regex-v1"
  | "tree-sitter-v1"
  | "runtime-v1"

export const CodegraphNodeSchema = Schema.Struct({
  id: Schema.String,
  fileID: Schema.String,
  kind: Schema.Literals([
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
  ]),
  name: Schema.String,
  signature: Schema.optional(Schema.String),
  startLine: Schema.Number,
  endLine: Schema.Number,
  code: Schema.optional(Schema.String),
  derivation: Schema.optional(Schema.Literals(["regex-v1", "tree-sitter-v1", "runtime-v1"])),
}).annotate({ identifier: "Banyan/CodegraphNode" })

export type CodegraphEdge = {
  id: string
  fromNodeID: string
  toNodeID: string
  kind: CodegraphEdgeKind
  derivation?: CodegraphEdgeDerivation
  /**
   * 0-100 trust score set by the derived-edge pass. `binding-resolved` =
   * 100, `service-tag` = 80, `same-file` = 60, `heuristic-name` = 40.
   * Omitted (undefined) for parser edges that predate the confidence model.
   */
  confidence?: number
}

/**
 * Persisted import/export binding row. Mirrors `ParsedBinding` from
 * `langs/types.ts` plus the owning file id and index timestamp. Written by
 * `writeFileGraph` during the parse pass and read by the derived-edge pass
 * (`rebuildDerivedGraph`) to resolve qualified references and barrel chains.
 */
export type CodegraphBinding = {
  id: string
  fileID: string
  kind: "import" | "export" | "re-export" | "namespace-re-export" | "star-re-export"
  /** Local name in the source file: import alias, exported declaration name, or re-exported local name. */
  localName?: string
  /** Consumer-visible export name. `"*"` for star/namespace re-exports, `"default"` for default exports. */
  importedName?: string
  /** For imports: the name imported from the source module (differs from `localName` for `import { A as B }`). */
  exportName?: string
  /** Module specifier. Empty for local (non re-export) declarations. */
  source: string
  indexedAt: number
}

/**
 * How a test node was matched to its target symbol, ordered roughly
 * high-to-low confidence. `substring-low-confidence` is an explicit
 * diagnostic fallback (raw code substring with no graph evidence) and must
 * never be reported as a normal test hit.
 */
export type TestMatchDerivation =
  | "tested_by"
  | "references"
  | "import-binding"
  | "substring-low-confidence"

/** One evidence-bearing test match: the node plus how/why it matched. */
export type TestMatch = {
  readonly node: CodegraphNode
  readonly derivation: TestMatchDerivation
  readonly confidence: number
}

export type SubagentMessage = {
  id: string
  parentSessionID: string
  fromSession: string
  fromAgent: string
  toSession?: string
  toAgent?: string
  kind: "request" | "inform" | "answer" | "poll" | "steer" | "checkpoint" | "plan" | "plan_update" | "kill" | "review"
  // G3: planID correlation invariant — present on plan_update messages to bind
  // the update to a SubagentPlans row. Optional for legacy read compatibility;
  // required for plan_update kind.
  planID?: string
  // G4 (Phase 1D): reviewID correlation invariant — present on `review`
  // messages to bind the dispatch to a `subagent_review_requests` row.
  // Optional for legacy read compatibility; required for `review` kind.
  reviewID?: string
  payload: unknown
  deliveredAt?: number
  createdAt: number
}

export type PlanDefinition = {
  title: string
  steps: Array<{
    content: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
  }>
  exitCriteria: string
}

export interface PlanStepStatusUpdate {
  planID: string
  stepIndex: number
  status: "pending" | "in_progress" | "completed" | "cancelled"
}

export interface WorkspaceContext {
  readonly worktree: string
  readonly focusDirs: readonly string[]
}

export interface Diagnostic {
  readonly kind: string
  readonly message: string
}

export interface Ranking {
  readonly score: number
  readonly signals: {
    readonly exact: number
    readonly symbol: number
    readonly graph: number
    readonly git: number
    readonly workspace: number
  }
  readonly workspace?: WorkspaceContext
}

export interface ArchitecturalSlice {
  readonly status?: "success" | "partial" | "failed"
  readonly reason?: string
  readonly recoveryHint?: string
  readonly fallbackUsed?: boolean
  readonly degraded?: boolean
  readonly summary: string
  readonly entrypoints: readonly CodegraphNode[]
  readonly importantSymbols: readonly CodegraphNode[]
  readonly relatedTests: readonly CodegraphNode[]
  /** Per-result derivation + confidence for `relatedTests`, when the source context carried it. */
  readonly relatedTestsDetailed?: readonly TestMatch[]
  readonly relatedDocs: readonly CodegraphFile[]
  readonly configs: readonly CodegraphFile[]
  readonly routes: readonly CodegraphNode[]
  readonly dependencies: readonly { name: string; version?: string }[]
  readonly directCallers: readonly CodegraphNode[]
  readonly transitiveDependents: readonly CodegraphNode[]
  readonly moreAvailable?: { readonly callers?: number; readonly dependents?: number }
  // Phase 7 follow-up: explicit diagnostic states so callers can
  // distinguish "no-source-callers" / "no-edges-found" / "out-of-scope"
  // instead of inferring state from empty arrays.
  readonly diagnostics?: readonly Diagnostic[]
}

export interface RepositoryContext {
  readonly status?: "success" | "partial" | "failed"
  readonly reason?: string
  readonly recoveryHint?: string
  readonly fallbackUsed?: boolean
  readonly degraded?: boolean
  readonly query: string
  readonly symbols: readonly CodegraphNode[]
  readonly files: readonly CodegraphFile[]
  readonly graph: { readonly nodes: readonly CodegraphNode[]; readonly edges: readonly CodegraphEdge[] }
  readonly tests: readonly CodegraphNode[]
  /** Per-result derivation + confidence for `tests`. */
  readonly testsDetailed?: readonly TestMatch[]
  readonly docs: readonly CodegraphFile[]
  readonly configs: readonly CodegraphFile[]
  readonly git: {
    readonly recentCommits: readonly { sha: string; subject: string; ts: number }[]
    readonly ownership: ReadonlyMap<string, number>
  }
  readonly workspace?: WorkspaceContext
  readonly diagnostics?: readonly Diagnostic[]
  readonly ranking: Ranking
  readonly ambiguity?: { readonly total: number; readonly kept: number }
  readonly searchDerivation?: ResolutionDerivation
}

export type PeerInfo = {
  sessionID: string
  agent: string
  status: "active" | "idle" | "disconnected"
  lastSeenAt: number
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  lastActivityAt?: number
  blockedReason?: string
}

export type CodegraphMeta = {
  id: string
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
  schemaVersion: number
  indexedRoot?: string
}

export const GraphMeta = Schema.Struct({
  graphBuiltAt: Schema.Number,
  graphVersion: Schema.Number,
  graphCoverage: Schema.Number,
  totalFiles: Schema.Number,
  totalNodes: Schema.Number,
  totalEdges: Schema.Number,
})

/**
 * Rollout mode for the per-turn graph-first redirect in the common session
 * tool wrapper (`packages/opencode/src/session/tools.ts`). `off` (default)
 * changes no tool behavior; `advisory` appends a structured redirect note to
 * early source-code `read`/`grep`/`glob` results without blocking them;
 * `enforce` returns only the redirect until the model attempts a
 * graph/repository tool in the same turn.
 */
export type GraphFirstMode = "off" | "advisory" | "enforce"

/**
 * Outcome of a graph/repository tool call, classified from its rendered
 * output for adoption telemetry. Distinct from a readiness `BootstrapState`:
 * this describes what a tool RESULT reported, not the graph's build state.
 */
export type GraphOutcome =
  | "ok"
  | "not-found"
  | "empty"
  | "stale"
  | "failed"
  | "degraded"
  | "fallback"

/** The model-facing graph build state at the time an event was recorded. */
export type GraphPolicyGraphState = "ready" | "building" | "missing"

export type GraphPolicyEventType = "call" | "redirect" | "graph_attempt"

/**
 * A per-turn tool-call event recorded by the common session tool wrapper
 * into the `codegraph_policy_events` table. Together with the
 * `codegraph_tool_usage` aggregate this measures graph-first adoption:
 * graph attempt before fallback, first-use latency, result quality, and the
 * bootstrap state observed at call time.
 */
export interface GraphPolicyEvent {
  readonly sessionID: string
  readonly messageID: string
  readonly toolID: string
  readonly eventType: GraphPolicyEventType
  readonly mode: GraphFirstMode
  readonly ts: number
  readonly graphState?: GraphPolicyGraphState
  readonly outcome?: GraphOutcome
}