export * as RepositoryGatewayTypes from "./types"

import type { Effect } from "effect"

// Canonical Repository Gateway types. Adapted from the needle2 gateway plan
// §2.3 (specs/banyancode_needle2_gateway_implementation_plan.md) and spec
// §109 / §132-134 of specs/banyancode_needle2_universal_repository_intelligence_architecture.md,
// in Effect v4 style (readonly fields, ReadonlyArray/ReadonlySet).

// A single tool invocation observed by the gateway at interception time.
export interface RepositoryToolCall {
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

// A query recorded in an investigation session (§22).
export interface RepositoryQuery {
  readonly query: string
}

// Per-(repository, session, agent) investigation state (§22). Tracked
// entities/files/concepts plus the recent query history so later requests
// inherit investigation context.
export interface InvestigationState {
  readonly entities: ReadonlySet<string>
  readonly files: ReadonlySet<string>
  readonly concepts: ReadonlySet<string>
  readonly recentQueries: readonly RepositoryQuery[]
}

// Cheap repository metadata the router may consult (§134).
export interface RepositoryContext {
  readonly root: string
  readonly graphStatus: "fresh" | "stale" | "building" | "unavailable"
  readonly supportedLanguages: readonly string[]
  readonly graphCoverage?: {
    readonly indexedFiles: number
    readonly totalFiles: number
  }
}

// A single result row returned by a backend. `path` and `line` are the only
// fields the model-facing formatter relies on (callers-style "path:line"
// lists, plan §28); the rest are optional semantic decorations.
export interface RepositoryResultItem {
  readonly path: string
  readonly line?: number
  readonly kind?: string
  readonly name?: string
  readonly text?: string
  readonly score?: number
}

export interface RepositoryRequest {
  readonly source: "model-tool" | "native-banyan-tool" | "internal"
  readonly originalTool: string // "grep"
  readonly arguments: Record<string, unknown> // { pattern, path }
  // Session identity for the per-session JSONL trace file (spec §44). Populated
  // by the registry wrapper from ExecuteInput.sessionID in a later wave.
  readonly sessionID?: string
  readonly userRequest?: string
  readonly recentToolCalls?: readonly RepositoryToolCall[]
  readonly investigationState?: InvestigationState
  readonly repositoryContext?: RepositoryContext // { root, graphStatus, supportedLanguages, graphCoverage }
}

export type Relation =
  | "callers"
  | "callees"
  | "references"
  | "dependents"
  | "imports"
  | "implementations"
  | "extensions"

// The normalized, backend-resolvable form of a repository request (plan §2.3).
export type RepositoryOperation =
  | { readonly kind: "content"; readonly path: string; readonly range?: { readonly startLine?: number; readonly endLine?: number } }
  | { readonly kind: "text_search"; readonly pattern: string; readonly paths?: readonly string[] }
  | { readonly kind: "file_discovery"; readonly pattern: string; readonly path?: string }
  | { readonly kind: "symbol"; readonly query: string; readonly path?: string }
  | { readonly kind: "relationship"; readonly relation: Relation; readonly target: string }
  | { readonly kind: "structural"; readonly query: string; readonly language?: string }
  | { readonly kind: "architecture"; readonly query: string }
  | { readonly kind: "ownership"; readonly query: string }

export type RepositoryRoute = "direct" | "augment" | "intelligence"

export interface RouteDecision {
  readonly route: RepositoryRoute
  readonly operation?: RepositoryOperation
  readonly confidence: number
  readonly reasonCodes: readonly string[]
  // Router provenance (spec §43): implementation + versions recorded in traces.
  // The default NoopRouter reports { router: "noop", routerVersion: "0" };
  // RulesRouter / NeedleRouter carry their own identity.
  readonly router?: string
  readonly routerVersion?: string
  readonly policyVersion?: string
}

export type RepositoryResultSource = "filesystem" | "text-index" | "codegraph" | "tree-sitter" | "hybrid"

export interface RepositoryResult {
  readonly route: RepositoryRoute
  readonly operation: RepositoryOperation
  readonly source: RepositoryResultSource
  readonly results: readonly RepositoryResultItem[]
  // AUGMENT payload (spec §6.2 / §29): the compact symbol header produced by
  // the augment backend for a content operation. Present only when
  // `route === "augment"`; the gateway lifts it onto the GatewayOutcome.
  readonly header?: string
  readonly provenance: {
    readonly originalTool: string
    readonly resolvedOperation: string
    readonly router: string
    readonly routerVersion: string
  }
  readonly freshness?: {
    readonly graph: "fresh" | "stale" | "unavailable"
  }
}

// Router input (plan §2.7 / spec §133). Kept stable — do not add fields
// unless they materially affect routing (§134).
export interface RouterInput {
  readonly userRequest?: string
  readonly toolName: string
  readonly arguments: Record<string, unknown>
  readonly recentToolCalls: readonly RepositoryToolCall[]
  readonly investigationState?: InvestigationState
  readonly repositoryContext?: RepositoryContext
}

// Never-failing by contract: routers implement fail-closed semantics
// (catchAll inside) and must always resolve to a RouteDecision.
export interface ToolRouter {
  readonly classify: (input: RouterInput) => Effect.Effect<RouteDecision, never, never>
}
