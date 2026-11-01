/**
 * `codegraph_search` — scored fuzzy / BM25 / structural search.
 *
 * Ported from v1 `packages/core/src/tool/codegraph-search-tool.ts`. Tool ID,
 * parameters and output shape are unchanged. v1's `graph` / `subsystem` /
 * `tests` modes read the repository-intelligence service (workstream 3c); in
 * this workstream they are implemented directly on the codegraph
 * (`bfsPure` neighbours + `tested_by`/`test` node lookups) so the tool does
 * not silently return nothing.
 */
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { Interface as CodegraphRepoInterface } from "../codegraph-repo.js"
import type { Interface as SearchInterface, SearchMode, SearchResult } from "../search/search.js"
import type { Interface as StructuralQueriesInterface } from "../structural-queries/structural-queries.js"
import { bfsPure } from "../bfs.js"
import { resolveGraphTargetPure } from "../symbol-resolver.js"
import { CodegraphNodeSchema, type CodegraphEdgeKind, type CodegraphNode } from "../types.js"
import { formatCodegraphSearchResults } from "./format.js"
import { optionalBoolean, optionalNumber } from "./schema.js"

export const name = "codegraph_search"

export interface Deps {
  readonly repo: CodegraphRepoInterface
  readonly search: SearchInterface
  readonly structural: StructuralQueriesInterface
}

const SearchIntent = Schema.Literals(["exact", "prefix", "fuzzy", "structural", "graph", "subsystem", "tests"])

export const Input = Schema.Struct({
  query: Schema.String,
  modes: Schema.optional(Schema.Array(SearchIntent)),
  limit: optionalNumber,
})

const SearchSignalSchema = Schema.Struct({
  exact: optionalBoolean,
  prefix: optionalBoolean,
  camelCase: optionalBoolean,
  snake_case: optionalBoolean,
  bm25: optionalNumber,
  fuzzy: optionalNumber,
  qualified: optionalBoolean,
  graph: optionalNumber,
})

const SearchResultSchema = Schema.Struct({
  node: CodegraphNodeSchema,
  score: Schema.Number,
  signals: SearchSignalSchema,
})

export const Output = Schema.Struct({
  results: Schema.Array(SearchResultSchema),
})

const fuzzyModes: SearchMode[] = ["BM25", "Fuzzy", "Prefix", "CamelCase", "snake_case", "Qualified"]

const mergeResults = (lists: SearchResult[][], limit: number): SearchResult[] => {
  const merged = new Map<string, SearchResult>()
  for (const list of lists) {
    for (const r of list) {
      const existing = merged.get(r.node.id)
      if (!existing) {
        merged.set(r.node.id, { ...r, signals: { ...r.signals } })
        continue
      }
      const signals = { ...existing.signals }
      if (r.signals.exact) signals.exact = true
      if (r.signals.prefix) signals.prefix = true
      if (r.signals.camelCase) signals.camelCase = true
      if (r.signals.snake_case) signals.snake_case = true
      if (r.signals.qualified) signals.qualified = true
      if (r.signals.fuzzy !== undefined) {
        signals.fuzzy = signals.fuzzy !== undefined ? Math.min(signals.fuzzy, r.signals.fuzzy) : r.signals.fuzzy
      }
      if (r.signals.bm25 !== undefined) signals.bm25 = Math.max(signals.bm25 ?? 0, r.signals.bm25)
      merged.set(r.node.id, { node: existing.node, score: existing.score + r.score, signals })
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.node.name.length - b.node.name.length))
    .slice(0, limit)
}

const ALL_EDGE_KINDS: ReadonlySet<CodegraphEdgeKind> = new Set([
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

const neighbourNodes = (
  repo: CodegraphRepoInterface,
  nodeID: string,
  maxDepth: number,
): Effect.Effect<CodegraphNode[]> =>
  Effect.gen(function* () {
    const run = yield* bfsPure(repo, {
      start: [nodeID],
      direction: "both",
      edgeKinds: ALL_EDGE_KINDS,
      maxDepth,
      resultLimit: 100,
    })
    return run.results.map((r) => r.node)
  })

export const tool = (deps: Deps): Tool.Info<typeof Input, typeof Output> => ({
  name,
  description:
    "Use when:\n" +
    "  scored fuzzy / BM25 / structural search across the code graph.\n" +
    "Examples\n" +
    '  - "Search for `Effect.gen`"\n' +
    '  - "Find all references to `database`"\n' +
    "Returns\n" +
    "  { results: [{ node, score, signals }] }\n" +
    "Avoid when\n" +
    "  exact symbol lookup — codegraph_query is faster.\n" +
    "After this, often: codegraph_callers, codegraph_impact — to traverse from a hit.\n" +
    "Before this: codegraph_build (if not built).",
  input: Input,
  output: Output,
  options: { permission: name, codemode: true },
  execute: (input) => {
    const limit = input.limit ?? 50
    const modes = input.modes ?? ["fuzzy"]
    return Effect.gen(function* () {
      const lists: SearchResult[][] = []
      for (const mode of modes) {
        if (mode === "exact") lists.push(yield* deps.search.searchExact(input.query))
        if (mode === "prefix") lists.push(yield* deps.search.searchPrefix(input.query))
        if (mode === "fuzzy") lists.push(yield* deps.search.search(input.query, { modes: fuzzyModes, limit }))
        if (mode === "structural") {
          const q = input.query.toLowerCase()
          let nodes: CodegraphNode[] = []
          if (q.includes("route") || q.includes("endpoint")) {
            nodes = yield* deps.structural.findHTTPRoutes({})
          } else if (q.includes("async")) {
            nodes = yield* deps.structural.findAsyncFunctions({})
          } else if (q.includes("recursive")) {
            nodes = yield* deps.structural.findRecursiveFunctions({})
          } else if (q.includes("implement") || q.includes("extends")) {
            const target = input.query.split(/\s+/).pop() ?? input.query
            nodes = yield* deps.structural.findImplementations({ interfaceName: target })
          } else if (q.includes("override") || q.includes("method")) {
            const target = input.query.split(/\s+/).pop() ?? input.query
            nodes = yield* deps.structural.findOverrides({ methodName: target })
          }
          lists.push(nodes.map((node) => ({ node, score: 1, signals: {} })))
        }
        if (mode === "graph" || mode === "subsystem") {
          const resolved = yield* resolveGraphTargetPure(deps.repo, { target: input.query, limit: 1 })
          if (resolved._tag === "Ok") {
            const related = yield* neighbourNodes(deps.repo, resolved.value.nodeID, 2)
            if (mode === "subsystem") {
              lists.push([
                { node: resolved.value.node, score: 2, signals: {} },
                ...related
                  .filter((n) => n.id !== resolved.value.nodeID)
                  .map((node) => ({ node, score: 1, signals: {} })),
              ])
            } else {
              lists.push(related.map((node) => ({ node, score: 1, signals: { graph: 1 } })))
            }
          }
        }
        if (mode === "tests") {
          const resolved = yield* resolveGraphTargetPure(deps.repo, { target: input.query, limit: 1 })
          if (resolved._tag === "Ok") {
            const edges = yield* deps.repo.edgesFrom(resolved.value.nodeID)
            const testEdges = edges.filter((edge) => edge.kind === "tested_by")
            const testNodes = yield* deps.repo.nodesByIDs(testEdges.map((edge) => edge.toNodeID))
            const kindTests = yield* deps.repo.listNodesByKind("test")
            const byName = kindTests.filter((n) => n.name.toLowerCase().includes(input.query.toLowerCase()))
            const seen = new Set<string>()
            const hits = [...testNodes, ...byName].filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
            lists.push(hits.map((node) => ({ node, score: 1, signals: {} })))
          }
        }
      }
      const output = { results: mergeResults(lists, limit) }
      return { output, content: formatCodegraphSearchResults(output.results) }
    }).pipe(Effect.mapError(() => new Tool.Error({ message: "codegraph_search failed" })))
  },
})
