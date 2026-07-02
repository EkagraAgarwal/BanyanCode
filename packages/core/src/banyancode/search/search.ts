import { Context, Effect } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import { levenshtein } from "./levenshtein"
import { camelToSnake, matchesCamelCaseInitials } from "./camelcase"
import type { CodegraphNode } from "../types"

// ─── Types ─────────────────────────────────────────────────────────────────

export type SearchMode = "BM25" | "Fuzzy" | "Prefix" | "CamelCase" | "snake_case" | "Exact" | "Qualified"

export interface SearchSignal {
  exact?: boolean
  prefix?: boolean
  camelCase?: boolean
  snake_case?: boolean
  bm25?: number
  fuzzy?: number // distance 0, 1, or 2; undefined = no match
  qualified?: boolean
  graph?: number // callers + callees count, capped
  git?: number // stubbed to 0
  workspace?: number // stubbed to 0
}

export interface SearchResult {
  node: CodegraphNode
  score: number
  signals: SearchSignal
}

export interface SearchOptions {
  modes?: SearchMode[]
  limit?: number
  maxFuzzyDistance?: number
}

// ─── Score Weights ───────────────────────────────────────────────────────────

const WEIGHT_EXACT = 10.0
const WEIGHT_PREFIX = 5.0
const WEIGHT_CAMEL_CASE = 4.0
const WEIGHT_SNAKE_CASE = 4.0
const WEIGHT_BM25 = 8.0
const WEIGHT_FUZZY_0 = 3.0
const WEIGHT_FUZZY_1 = 2.0
const WEIGHT_FUZZY_2 = 1.0
const WEIGHT_QUALIFIED = 3.0
const WEIGHT_GRAPH_MAX = 5.0
const GRAPH_PER_NEIGHBOR = 0.5

// ─── Service Interface ───────────────────────────────────────────────────────

export interface Interface {
  readonly searchExact: (query: string) => Effect.Effect<SearchResult[], never, never>
  readonly searchPrefix: (query: string) => Effect.Effect<SearchResult[], never, never>
  readonly searchCamelCase: (query: string) => Effect.Effect<SearchResult[], never, never>
  readonly searchSnakeCase: (query: string) => Effect.Effect<SearchResult[], never, never>
  readonly searchQualified: (query: string) => Effect.Effect<SearchResult[], never, never>
  readonly searchBM25: (query: string, limit?: number) => Effect.Effect<SearchResult[], never, never>
  readonly searchFuzzy: (query: string, maxDistance?: number) => Effect.Effect<SearchResult[], never, never>
  readonly search: (query: string, options?: SearchOptions) => Effect.Effect<SearchResult[], never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/Search") {}

// ─── BM25 Implementation ─────────────────────────────────────────────────────

/**
 * Compute a simple BM25-style score in-memory over listAllNodes.
 * Uses term frequency and inverse document frequency.
 * Fields searched: name + signature.
 */
function bm25Score(query: string, doc: { name: string; signature?: string }, docCount: number, avgDocLen: number): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return 0

  const docText = `${doc.name} ${doc.signature ?? ""}`.toLowerCase()
  const docLen = docText.split(/\s+/).length

  let score = 0
  const k1 = 1.5
  const b = 0.75

  for (const term of terms) {
    const tf = (docText.match(new RegExp(term, "g")) ?? []).length
    if (tf === 0) continue

    // IDF: log((docCount - df + 0.5) / (df + 0.5))
    // Approximate df as the number of docs containing the term (scan all docs in caller)
    // For simplicity we use a fixed IDF = 1 for terms we find
    const idf = Math.log((docCount + 1) / (1 + 1))
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)))
  }

  return score
}

// ─── Search Mode Implementations ────────────────────────────────────────────

function modeExact(query: string, nodes: CodegraphNode[]): SearchResult[] {
  const q = query.toLowerCase()
  return nodes
    .filter((n) => n.name.toLowerCase() === q)
    .map((node) => ({
      node,
      score: WEIGHT_EXACT,
      signals: { exact: true },
    }))
}

function modePrefix(query: string, nodes: CodegraphNode[]): SearchResult[] {
  const q = query.toLowerCase()
  return nodes
    .filter((n) => n.name.toLowerCase().startsWith(q))
    .map((node) => ({
      node,
      score: WEIGHT_PREFIX,
      signals: { prefix: true },
    }))
}

function modeCamelCase(query: string, nodes: CodegraphNode[]): SearchResult[] {
  return nodes
    .filter((n) => matchesCamelCaseInitials(query, n.name))
    .map((node) => ({
      node,
      score: WEIGHT_CAMEL_CASE,
      signals: { camelCase: true },
    }))
}

function modeSnakeCase(query: string, nodes: CodegraphNode[]): SearchResult[] {
  const normalized = query.toLowerCase().replace(/[\s-]+/g, "_")
  return nodes
    .filter((n) => camelToSnake(n.name) === normalized)
    .map((node) => ({
      node,
      score: WEIGHT_SNAKE_CASE,
      signals: { snake_case: true },
    }))
}

function modeQualified(query: string, nodes: CodegraphNode[]): SearchResult[] {
  const parts = query.split(".")
  if (parts.length < 2) return []

  const lastSegment = parts[parts.length - 1].toLowerCase()
  // For qualified name, we just match by the last segment against name
  // Path matching would require file info which we don't have in nodes directly
  return nodes
    .filter((n) => n.name.toLowerCase() === lastSegment)
    .map((node) => ({
      node,
      score: WEIGHT_QUALIFIED,
      signals: { qualified: true },
    }))
}

function modeBM25(query: string, nodes: CodegraphNode[], limit = 100): SearchResult[] {
  if (!query.trim()) return []

  const docCount = nodes.length
  if (docCount === 0) return []

  const avgDocLen = nodes.reduce((sum, n) => {
    return sum + (n.name.length + (n.signature?.length ?? 0))
  }, 0) / docCount

  const scored = nodes.map((node) => ({
    node,
    bm25: bm25Score(query, node, docCount, avgDocLen),
  }))

  // Sort by BM25 descending and take top results
  const maxBm25 = Math.max(...scored.map((s) => s.bm25), 1)

  const q = query.toLowerCase()
  return scored
    .filter((s) => s.bm25 > 0)
    .sort((a, b) => {
      const aStarts = a.node.name.toLowerCase().startsWith(q)
      const bStarts = b.node.name.toLowerCase().startsWith(q)
      if (aStarts !== bStarts) return aStarts ? -1 : 1
      if (aStarts && bStarts && a.node.name.length !== b.node.name.length) {
        return b.node.name.length - a.node.name.length
      }
      if (b.bm25 !== a.bm25) return b.bm25 - a.bm25
      return a.node.name.length - b.node.name.length
    })
    .slice(0, limit)
    .map(({ node, bm25 }) => ({
      node,
      score: (bm25 / maxBm25) * WEIGHT_BM25,
      signals: { bm25: bm25 / maxBm25 },
    }))
}

function modeFuzzy(query: string, nodes: CodegraphNode[], maxDistance = 2): SearchResult[] {
  const q = query.toLowerCase()
  return nodes
    .map((n) => {
      const distName = levenshtein(q, n.name.toLowerCase())
      const baseName = n.name.toLowerCase()
      const distBase = levenshtein(q, baseName.substring(baseName.lastIndexOf("/") + 1))
      const dist = Math.min(distName, distBase)
      return { node: n, dist }
    })
    .filter(({ dist }) => dist <= maxDistance)
    .map(({ node, dist }) => ({
      node,
      score: dist === 0 ? WEIGHT_FUZZY_0 : dist === 1 ? WEIGHT_FUZZY_1 : WEIGHT_FUZZY_2,
      signals: { fuzzy: dist } as SearchSignal,
    }))
}

// ─── Graph Signal (stubbed) ──────────────────────────────────────────────────

function graphSignal(_nodeID: string, _edges: Map<string, { callers: number; callees: number }>): number {
  // Stub: return 0. Graph expansion will be added in a future phase.
  return 0
}

// ─── Combined Search ─────────────────────────────────────────────────────────

function mergeAndRank(results: SearchResult[], limit: number): SearchResult[] {
  const merged = new Map<string, SearchResult>()

  for (const r of results) {
    const existing = merged.get(r.node.id)
    if (existing) {
      // Merge signals and sum scores
      const signals = { ...existing.signals }
      if (r.signals.exact) signals.exact = true
      if (r.signals.prefix) signals.prefix = true
      if (r.signals.camelCase) signals.camelCase = true
      if (r.signals.snake_case) signals.snake_case = true
      if (r.signals.fuzzy !== undefined) {
        signals.fuzzy = signals.fuzzy !== undefined ? Math.min(signals.fuzzy, r.signals.fuzzy) : r.signals.fuzzy
      }
      if (r.signals.qualified) signals.qualified = true
      if (r.signals.graph !== undefined) {
        signals.graph = (signals.graph ?? 0) + r.signals.graph
      }
      if (r.signals.bm25 !== undefined) {
        signals.bm25 = Math.max(signals.bm25 ?? 0, r.signals.bm25)
      }

      merged.set(r.node.id, {
        node: existing.node,
        score: existing.score + r.score,
        signals,
      })
    } else {
      merged.set(r.node.id, { ...r })
    }
  }

  // Sort by score descending, then by name.length ascending for ties
  return Array.from(merged.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.node.name.length - b.node.name.length
    })
    .slice(0, limit)
}

// ─── Service Factory ─────────────────────────────────────────────────────────

export function makeService(repo: CodegraphRepo.Interface): Interface {
  const searchExact = (query: string): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const nodes = yield* repo.listAllNodes()
      return modeExact(query, nodes)
    })

  const searchPrefix = (query: string): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const nodes = yield* repo.listAllNodes()
      return modePrefix(query, nodes)
    })

  const searchCamelCase = (query: string): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const nodes = yield* repo.listAllNodes()
      return modeCamelCase(query, nodes)
    })

  const searchSnakeCase = (query: string): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const nodes = yield* repo.listAllNodes()
      return modeSnakeCase(query, nodes)
    })

  const searchQualified = (query: string): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const nodes = yield* repo.listAllNodes()
      return modeQualified(query, nodes)
    })

  const searchBM25 = (query: string, limit?: number): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const nodes = yield* repo.listAllNodes()
      return modeBM25(query, nodes, limit ?? 100)
    })

  const searchFuzzy = (query: string, maxDistance?: number): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const nodes = yield* repo.listAllNodes()
      return modeFuzzy(query, nodes, maxDistance ?? 2)
    })

  const search = (query: string, options?: SearchOptions): Effect.Effect<SearchResult[], never, never> =>
    Effect.gen(function* () {
      const modes = options?.modes ?? ["BM25", "Fuzzy", "Prefix", "CamelCase"]
      const limit = options?.limit ?? 50
      const maxFuzzy = options?.maxFuzzyDistance ?? 2

      const allNodes = yield* repo.listAllNodes()
      const allEdges = yield* repo.listAllEdges()

      // Build edge map for graph signal
      const edgeMap = new Map<string, { callers: number; callees: number }>()
      for (const edge of allEdges) {
        const callers = edgeMap.get(edge.toNodeID) ?? { callers: 0, callees: 0 }
        callers.callers++
        edgeMap.set(edge.toNodeID, callers)

        const callees = edgeMap.get(edge.fromNodeID) ?? { callers: 0, callees: 0 }
        callees.callees++
        edgeMap.set(edge.fromNodeID, callees)
      }

      const modeResults: SearchResult[] = []

      for (const mode of modes) {
        let results: SearchResult[] = []
        switch (mode) {
          case "Exact":
            results = modeExact(query, allNodes)
            break
          case "Prefix":
            results = modePrefix(query, allNodes)
            break
          case "CamelCase":
            results = modeCamelCase(query, allNodes)
            break
          case "snake_case":
            results = modeSnakeCase(query, allNodes)
            break
          case "Qualified":
            results = modeQualified(query, allNodes)
            break
          case "BM25":
            results = modeBM25(query, allNodes, limit)
            break
          case "Fuzzy":
            results = modeFuzzy(query, allNodes, maxFuzzy)
            break
        }

        // Add graph signal
        results = results.map((r) => {
          const gs = graphSignal(r.node.id, edgeMap)
          const cappedGs = Math.min(gs, WEIGHT_GRAPH_MAX)
          return {
            ...r,
            score: r.score + cappedGs,
            signals: { ...r.signals, graph: gs, git: 0, workspace: 0 },
          }
        })

        modeResults.push(...results)
      }

      return mergeAndRank(modeResults, limit)
    })

  return {
    searchExact,
    searchPrefix,
    searchCamelCase,
    searchSnakeCase,
    searchQualified,
    searchBM25,
    searchFuzzy,
    search,
  }
}
