import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { SearchMode, SearchResult } from "@opencode-ai/core/banyancode/search/search"
import { RootHttpApi } from "../api"

const fuzzyModes: SearchMode[] = ["BM25", "Fuzzy", "Prefix", "CamelCase", "snake_case", "Qualified"]

const mergeSearchResults = (lists: SearchResult[][], limit: number) => {
  const merged = new Map<string, SearchResult>()
  for (const list of lists) {
    for (const r of list) {
      const existing = merged.get(r.node.id)
      if (!existing) {
        merged.set(r.node.id, { ...r, signals: { ...r.signals } })
        continue
      }
      merged.set(r.node.id, {
        node: existing.node,
        score: existing.score + r.score,
        signals: { ...existing.signals, ...r.signals },
      })
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.node.name.length - b.node.name.length))
    .slice(0, limit)
}

export const repositoryIntelHandlers = HttpApiBuilder.group(RootHttpApi, "repository-intel", (handlers) =>
  Effect.gen(function* () {
    const intel = yield* Banyan.RepositoryIntelligence
    const search = yield* Banyan.Search
    const structural = yield* Banyan.StructuralQueries

    const findSymbolHandler = Effect.fn("RepositoryIntel.findSymbol")(function* (ctx: {
      payload: { name: string; kind?: string; file?: string; exact?: boolean }
    }) {
      return yield* intel.findSymbol({
        name: ctx.payload.name,
        kind: ctx.payload.kind as Banyan.CodegraphNode["kind"] | undefined,
        file: ctx.payload.file,
        exact: ctx.payload.exact,
      })
    })

    const findSubsystemHandler = Effect.fn("RepositoryIntel.findSubsystem")(function* (ctx: {
      payload: { query: string; maxDepth?: number }
    }) {
      return yield* intel.findSubsystem(ctx.payload)
    })

    const findEntrypointsHandler = Effect.fn("RepositoryIntel.findEntrypoints")(function* (ctx: {
      payload: { feature: string }
    }) {
      return yield* intel.findEntrypoints(ctx.payload)
    })

    const findTestsHandler = Effect.fn("RepositoryIntel.findTests")(function* (ctx: {
      payload: { symbol: string }
    }) {
      return yield* intel.findTests(ctx.payload)
    })

    const findRelatedHandler = Effect.fn("RepositoryIntel.findRelated")(function* (ctx: {
      payload: { nodeID: string; depth?: number }
    }) {
      return yield* intel.findRelated(ctx.payload)
    })

    const estimateImpactHandler = Effect.fn("RepositoryIntel.estimateImpact")(function* (ctx: {
      payload: { readonly paths: readonly string[]; maxDepth?: number }
    }) {
      return yield* intel.estimateImpact({ paths: [...ctx.payload.paths], maxDepth: ctx.payload.maxDepth })
    })

    const traceExecutionHandler = Effect.fn("RepositoryIntel.traceExecution")(function* (ctx: {
      payload: { from: string; maxDepth?: number }
    }) {
      return yield* intel.traceExecution(ctx.payload)
    })

    const searchHandler = Effect.fn("RepositoryIntel.search")(function* (ctx: {
      payload: {
        query: string
        modes?: ReadonlyArray<"exact" | "prefix" | "fuzzy" | "structural" | "graph" | "subsystem" | "tests">
        limit?: number
      }
    }) {
      const limit = ctx.payload.limit ?? 50
      const modes = ctx.payload.modes ? [...ctx.payload.modes] : ["fuzzy"]
      const lists: SearchResult[][] = []

      for (const mode of modes) {
        if (mode === "exact") lists.push(yield* search.searchExact(ctx.payload.query))
        if (mode === "prefix") lists.push(yield* search.searchPrefix(ctx.payload.query))
        if (mode === "fuzzy") lists.push(yield* search.search(ctx.payload.query, { modes: fuzzyModes, limit }))
        if (mode === "structural") {
          const q = ctx.payload.query.toLowerCase()
          let nodes: Banyan.CodegraphNode[] = []
          if (q.includes("route") || q.includes("endpoint")) nodes = yield* structural.findHTTPRoutes({})
          else if (q.includes("async")) nodes = yield* structural.findAsyncFunctions({})
          else if (q.includes("recursive")) nodes = yield* structural.findRecursiveFunctions({})
          else if (q.includes("implement") || q.includes("extends")) {
            nodes = yield* structural.findImplementations({
              interfaceName: ctx.payload.query.split(/\s+/).pop() ?? ctx.payload.query,
            })
          } else if (q.includes("override") || q.includes("method")) {
            nodes = yield* structural.findOverrides({
              methodName: ctx.payload.query.split(/\s+/).pop() ?? ctx.payload.query,
            })
          }
          lists.push(nodes.map((node) => ({ node, score: 1, signals: {} })))
        }
        if (mode === "graph") {
          const symbols = yield* intel.findSymbol({ name: ctx.payload.query })
          if (symbols[0]) {
            const related = yield* intel.findRelated({ nodeID: symbols[0].id, depth: 2 })
            lists.push(related.map((node) => ({ node, score: 1, signals: { graph: 1 } })))
          }
        }
        if (mode === "subsystem") {
          const { entry, related } = yield* intel.findSubsystem({ query: ctx.payload.query })
          lists.push([
            { node: entry, score: 2, signals: {} },
            ...related.map((node) => ({ node, score: 1, signals: {} })),
          ])
        }
        if (mode === "tests") {
          const nodes = yield* intel.findTests({ symbol: ctx.payload.query })
          lists.push(nodes.map((node) => ({ node, score: 1, signals: {} })))
        }
      }

      return mergeSearchResults(lists, limit)
    })

    const findImplementationsHandler = Effect.fn("RepositoryIntel.findImplementations")(function* (ctx: {
      payload: { interfaceName: string; file?: string; language?: string }
    }) {
      return yield* structural.findImplementations(ctx.payload)
    })

    const findOverridesHandler = Effect.fn("RepositoryIntel.findOverrides")(function* (ctx: {
      payload: { methodName: string; baseClass?: string; file?: string; language?: string }
    }) {
      return yield* structural.findOverrides(ctx.payload)
    })

    const findRecursiveHandler = Effect.fn("RepositoryIntel.findRecursive")(function* (ctx: {
      payload: { file?: string; language?: string }
    }) {
      return yield* structural.findRecursiveFunctions(ctx.payload)
    })

    const findAsyncHandler = Effect.fn("RepositoryIntel.findAsync")(function* (ctx: {
      payload: { file?: string; language?: string }
    }) {
      return yield* structural.findAsyncFunctions(ctx.payload)
    })

    const findHttpRoutesHandler = Effect.fn("RepositoryIntel.findHttpRoutes")(function* (ctx: {
      payload: { file?: string; language?: string }
    }) {
      return yield* structural.findHTTPRoutes(ctx.payload)
    })

    return handlers
      .handle("findSymbol", findSymbolHandler)
      .handle("findSubsystem", findSubsystemHandler)
      .handle("findEntrypoints", findEntrypointsHandler)
      .handle("findTests", findTestsHandler)
      .handle("findRelated", findRelatedHandler)
      .handle("estimateImpact", estimateImpactHandler)
      .handle("traceExecution", traceExecutionHandler)
      .handle("search", searchHandler)
      .handle("findImplementations", findImplementationsHandler)
      .handle("findOverrides", findOverridesHandler)
      .handle("findRecursive", findRecursiveHandler)
      .handle("findAsync", findAsyncHandler)
      .handle("findHttpRoutes", findHttpRoutesHandler)
  }),
)
