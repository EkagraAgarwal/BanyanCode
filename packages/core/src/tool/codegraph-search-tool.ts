export * as CodegraphSearchTool from "./codegraph-search-tool"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as searchLayer } from "../banyancode/search"
import { defaultLayer as repositoryIntelligenceLayer } from "../banyancode/repository-intelligence"
import { defaultLayer as structuralQueriesLayer } from "../banyancode/structural-queries"
import type { SearchMode, SearchResult } from "../banyancode/search/search"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "codegraph_search"

const SearchIntent = Schema.Literals(["exact", "prefix", "fuzzy", "structural", "graph", "subsystem", "tests"])

export const Input = Schema.Struct({
  query: Schema.String,
  modes: Schema.optional(Schema.Array(SearchIntent)),
  limit: Schema.optional(Schema.Number),
})

const SearchSignalSchema = Schema.Struct({
  exact: Schema.optional(Schema.Boolean),
  prefix: Schema.optional(Schema.Boolean),
  camelCase: Schema.optional(Schema.Boolean),
  snake_case: Schema.optional(Schema.Boolean),
  bm25: Schema.optional(Schema.Number),
  fuzzy: Schema.optional(Schema.Number),
  qualified: Schema.optional(Schema.Boolean),
  graph: Schema.optional(Schema.Number),
  git: Schema.optional(Schema.Number),
  workspace: Schema.optional(Schema.Number),
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
      if (r.signals.bm25 !== undefined) {
        signals.bm25 = Math.max(signals.bm25 ?? 0, r.signals.bm25)
      }
      merged.set(r.node.id, {
        node: existing.node,
        score: existing.score + r.score,
        signals,
      })
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.node.name.length - b.node.name.length))
    .slice(0, limit)
}

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const search = yield* Banyan.Search
    const intel = yield* Banyan.RepositoryIntelligence
    const structural = yield* Banyan.StructuralQueries

    yield* tools.register({
      [name]: Tool.make({
        description:
          "Search the code graph with intent modes: exact, prefix, fuzzy, structural, graph, subsystem, tests.",
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [{ type: "text", text: `${output.results.length} results` }],
        execute: (input, context) => {
          const limit = input.limit ?? 50
          const modes = input.modes ?? ["fuzzy"]
          return traced(
            process.cwd(),
            context.sessionID,
            name,
            input,
            (output) => `results=${output.results.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const lists: SearchResult[][] = []

              for (const mode of modes) {
                if (mode === "exact") {
                  lists.push(yield* search.searchExact(input.query))
                }
                if (mode === "prefix") {
                  lists.push(yield* search.searchPrefix(input.query))
                }
                if (mode === "fuzzy") {
                  lists.push(yield* search.search(input.query, { modes: fuzzyModes, limit }))
                }
                if (mode === "structural") {
                  const q = input.query.toLowerCase()
                  let nodes: Banyan.CodegraphNode[] = []
                  if (q.includes("route") || q.includes("endpoint")) {
                    nodes = yield* structural.findHTTPRoutes({})
                  } else if (q.includes("async")) {
                    nodes = yield* structural.findAsyncFunctions({})
                  } else if (q.includes("recursive")) {
                    nodes = yield* structural.findRecursiveFunctions({})
                  } else if (q.includes("implement") || q.includes("extends")) {
                    const name = input.query.split(/\s+/).pop() ?? input.query
                    nodes = yield* structural.findImplementations({ interfaceName: name })
                  } else if (q.includes("override") || q.includes("method")) {
                    const name = input.query.split(/\s+/).pop() ?? input.query
                    nodes = yield* structural.findOverrides({ methodName: name })
                  }
                  lists.push(nodes.map((node) => ({ node, score: 1, signals: {} })))
                }
                if (mode === "graph") {
                  const symbols = yield* intel.findSymbol({ name: input.query })
                  if (symbols[0]) {
                    const related = yield* intel.findRelated({ nodeID: symbols[0].id, depth: 2 })
                    lists.push(related.map((node) => ({ node, score: 1, signals: { graph: 1 } })))
                  }
                }
                if (mode === "subsystem") {
                  const { entry, related } = yield* intel.findSubsystem({ query: input.query })
                  lists.push([{ node: entry, score: 2, signals: {} }, ...related.map((node) => ({ node, score: 1, signals: {} }))])
                }
                if (mode === "tests") {
                  const nodes = yield* intel.findTests({ symbol: input.query })
                  lists.push(nodes.map((node) => ({ node, score: 1, signals: {} })))
                }
              }

              return { results: mergeResults(lists, limit) }
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "codegraph_search failed" })))
        },
      }),
    })
  }),
).pipe(
  Layer.provide(searchLayer),
  Layer.provide(repositoryIntelligenceLayer),
  Layer.provide(structuralQueriesLayer),
)
