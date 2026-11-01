export * as GatewayTypes from "./types.js"

import type { Effect } from "effect"

// Ported from v1 `packages/core/src/banyancode/gateway/types.ts` (spec §20/§109),
// trimmed to the pieces the v2 tool-hook gateway consumes.

export interface RepositoryToolCall {
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

export type Relation =
  | "callers"
  | "callees"
  | "references"
  | "dependents"
  | "imports"
  | "implementations"
  | "extensions"

export interface RepositoryRequest {
  readonly source: "model-tool" | "native-banyan-tool" | "internal"
  readonly originalTool: string
  readonly arguments: Record<string, unknown>
  readonly sessionID?: string
  readonly userRequest?: string
  readonly recentToolCalls?: readonly RepositoryToolCall[]
}

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
  readonly router?: string
  readonly routerVersion?: string
  readonly policyVersion?: string
}

export interface RouterInput {
  readonly userRequest?: string
  readonly toolName: string
  readonly arguments: Record<string, unknown>
  readonly recentToolCalls: readonly RepositoryToolCall[]
}

// Never-failing by contract: routers implement fail-closed semantics and must
// always resolve to a RouteDecision.
export interface ToolRouter {
  readonly classify: (input: RouterInput) => Effect.Effect<RouteDecision, never, never>
}

/** The route a repository operation should take (v1 routing/types.ts). */
export type RouteVerdict = "direct" | "intelligence" | "hybrid"

export interface RuleInput {
  readonly toolName: string
  readonly arguments: Record<string, unknown>
  readonly userRequest?: string
  readonly paths?: string[]
}

export interface RuleVerdict {
  readonly verdict: RouteVerdict
  readonly reasonCodes: string[]
  readonly confidence: number
}

/** A tool call rewrite produced by the codegraph adapter. */
export interface GatewayRewrite {
  readonly tool: string
  readonly input: Record<string, unknown>
}

/**
 * Small seam the lead satisfies once the codegraph port lands. Every method is
 * optional: a partial or missing adapter keeps the corresponding gateway
 * feature a byte-for-byte no-op.
 */
export interface CodegraphQuery {
  /**
   * Map an INTELLIGENCE decision (symbol/relationship operation) onto a
   * registered codegraph tool call. Returning undefined (or throwing) makes
   * the gateway fall through to the original tool.
   */
  readonly route?: (input: {
    readonly operation: RepositoryOperation
    readonly call: { readonly tool: string; readonly input: Record<string, unknown> }
    readonly sessionID: string
  }) => Effect.Effect<GatewayRewrite | undefined, never, never>
  /**
   * Compact symbol header for a code-file read. Returning undefined (or
   * throwing) leaves the read result untouched.
   */
  readonly augmentRead?: (input: {
    readonly path: string
    readonly sessionID: string
  }) => Effect.Effect<string | undefined, never, never>
}
