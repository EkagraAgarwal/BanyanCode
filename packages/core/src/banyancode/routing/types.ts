/**
 * Deterministic routing rules — self-contained types.
 *
 * This module is deliberately decoupled from the gateway: it is a pure,
 * side-effect-free decision layer that is consumed later by the
 * RepositoryGateway (spec §20, §21, §24, §135 of the universal repository
 * intelligence architecture). Do NOT import from ../gateway here.
 */

/** The route a repository operation should take. */
export type RouteVerdict = "direct" | "intelligence" | "hybrid"

/**
 * Normalized input to the deterministic router. `paths` is a convenience for
 * callers that already resolved a scope; when absent, paths are derived from
 * `arguments` (`path`, `paths`, `directory`, and the glob `pattern`).
 */
export interface RuleInput {
  /** Original tool id, e.g. "read" | "grep" | "glob". */
  toolName: string
  /** Raw tool arguments as passed to the tool. */
  arguments: Record<string, unknown>
  /** The user's original request text when available (spec §21). */
  userRequest?: string
  /** Pre-resolved scope paths (optional; overrides arg-derived paths). */
  paths?: string[]
}

/**
 * Result of evaluating the deterministic rules.
 *
 * - `reasonCodes`: stable kebab-case codes explaining the decision
 *   (e.g. "docs-scoped", "relationship-language", "fallback-direct").
 * - `confidence`: banded per spec §24 — direct=1 for strong direct,
 *   intelligence=0.9 for strong relationship language, hybrid=0.75 when both
 *   signals are present, else direct=0.5 heuristic fallback.
 */
export interface RuleVerdict {
  verdict: RouteVerdict
  reasonCodes: string[]
  confidence: number
}
