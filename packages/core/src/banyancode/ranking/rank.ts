/**
 * Retrieval ranking layer — pure, no I/O, no Effect dependencies.
 *
 * ## Score formula
 *
 * ```
 * score = (exact ? 10.0 : 0)
 *       + (prefixMatch ? 5.0 : 0)
 *       + (camelMatch ? 4.0 : 0)
 *       + (snakeMatch ? 4.0 : 0)
 *       + (bm25Score * 8.0)
 *       + fuzzyWeight(fuzzyDistance)   // dist 0: +3, dist 1: +2, dist 2: +1
 *       + (qualifiedMatch ? 3.0 : 0)
 *       + (min(directCallers + directCallees, 10) * 0.5)
 *       + (gitFrequency * 0.5)
 *       + ((workspaceProximity + failingTests) * 0.5)
 * ```
 *
 * Tie-breaker: shorter `candidate.name` wins (deterministic, alphabetical).
 *
 * ## Signal buckets
 *
 * The `signals` breakdown is the contribution of each logical bucket to the
 * final score — useful for debugging and TUI "why was this ranked here?"
 *
 * - **exact**: exact name match bonus
 * - **symbol**: prefix + camel + snake + qualified signal sum
 * - **graph**: saturated caller+callee contribution
 * - **git**: git frequency contribution
 * - **workspace**: workspace proximity + failing tests contribution
 */

import type { CodegraphNode, WorkspaceContext } from "../types"

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export type RankingInput = {
  candidate: CodegraphNode
  query: string
  filePath?: string
  // Pre-computed lexical features (caller fills these in)
  exactMatch: boolean
  prefixMatch: boolean
  camelMatch: boolean
  snakeMatch: boolean
  bm25Score: number // normalized 0..1 from BM25
  fuzzyDistance: number // 0..3, or Infinity if no match
  qualifiedMatch: boolean // last segment of dotted path matches
  // Graph features
  directCallers: number
  directCallees: number
  // Git features (stub for now — Phase 7 wires this up)
  gitFrequency: number
  // Workspace features (stub for now — Phase 3 wires this up)
  workspaceProximity: number
  // Diagnostics features (stub for now — Phase 3)
  failingTests: number
}

export type RankingResult = {
  score: number
  signals: {
    exact: number
    symbol: number
    graph: number
    git: number
    workspace: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fuzzy distance contribution.
 * dist 0 → 3.0, dist 1 → 2.0, dist 2 → 1.0, dist ≥ 3 or Infinity → 0
 */
function fuzzyWeight(distance: number): number {
  if (!Number.isFinite(distance)) return 0
  if (distance === 0) return 3.0
  if (distance === 1) return 2.0
  if (distance === 2) return 1.0
  return 0
}

// ---------------------------------------------------------------------------
// Core ranking function
// ---------------------------------------------------------------------------

/**
 * Score a candidate node against a query using multi-signal fusion.
 *
 * Pure — no I/O, no Effect. Designed to be called in-memory after the
 * caller has computed all pre-computed features (exactMatch, bm25Score, etc.).
 *
 * @param input - fully-populated RankingInput
 * @returns RankingResult with score and per-bucket signal breakdown
 */
export function rank(input: RankingInput): RankingResult
/**
 * Score a batch of candidates and optionally promote workspace-internal
 * results ahead of workspace-external results. When `opts.workspace` is
 * provided, results whose `filePath` falls inside any `focusDirs` entry
 * (or the worktree root) are sorted earlier. The sort is stable: the
 * relative order of results within each group is preserved.
 *
 * When `opts.workspace` is undefined the call is a no-op — results are
 * returned in their input order, only with per-result scoring applied.
 */
export function rank(
  inputs: readonly RankingInput[],
  opts?: { workspace?: WorkspaceContext }
): readonly RankingResult[]
export function rank(
  inputOrInputs: RankingInput | readonly RankingInput[],
  opts?: { workspace?: WorkspaceContext }
): RankingResult | readonly RankingResult[] {
  if (Array.isArray(inputOrInputs)) {
    return rankBatch(inputOrInputs, opts)
  }
  return rankSingle(inputOrInputs as RankingInput)
}

function rankSingle(input: RankingInput): RankingResult {
  const {
    candidate,
    exactMatch,
    prefixMatch,
    camelMatch,
    snakeMatch,
    bm25Score,
    fuzzyDistance,
    qualifiedMatch,
    directCallers,
    directCallees,
    gitFrequency,
    workspaceProximity,
    failingTests,
  } = input

  // Exact
  const exact = exactMatch ? 10.0 : 0.0

  // Symbol signals
  const symbol =
    (prefixMatch ? 5.0 : 0.0) +
    (camelMatch ? 4.0 : 0.0) +
    (snakeMatch ? 4.0 : 0.0) +
    (bm25Score * 8.0) +
    fuzzyWeight(fuzzyDistance) +
    (qualifiedMatch ? 3.0 : 0.0)

  // Graph signals — saturated at 10 connections
  const graph = Math.min(directCallers + directCallees, 10) * 0.5

  // Git signals
  const git = gitFrequency * 0.5

  // Workspace signals
  const workspace = (workspaceProximity + failingTests) * 0.5

  const score = exact + symbol + graph + git + workspace

  return {
    score,
    signals: { exact, symbol, graph, git, workspace },
  }
}

function rankBatch(
  inputs: readonly RankingInput[],
  opts?: { workspace?: WorkspaceContext }
): readonly RankingResult[] {
  const scored = inputs.map((i) => rankSingle(i))
  if (!opts?.workspace) return scored

  const { focusDirs } = opts.workspace
  if (focusDirs.length === 0) return scored

  const internal: RankingResult[] = []
  const external: RankingResult[] = []
  inputs.forEach((input, idx) => {
    if (isInWorkspace(input.filePath, focusDirs)) {
      internal.push(scored[idx]!)
    } else {
      external.push(scored[idx]!)
    }
  })
  return [...internal, ...external]
}

function isInWorkspace(filePath: string | undefined, focusDirs: readonly string[]): boolean {
  if (!filePath) return false
  return focusDirs.some((d) => filePath === d || filePath.startsWith(d + "/"))
}

/**
 * Tie-breaker comparator for sorting ranked candidates.
 * Shorter name wins; equal length falls back to lexical string comparison.
 */
export function rankTieBreaker(a: { candidate: CodegraphNode }, b: { candidate: CodegraphNode }): number {
  const lenA = a.candidate.name.length
  const lenB = b.candidate.name.length
  if (lenA !== lenB) return lenA - lenB
  return a.candidate.name.localeCompare(b.candidate.name)
}
