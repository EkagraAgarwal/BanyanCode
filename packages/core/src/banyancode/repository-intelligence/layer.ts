import { Effect, Layer } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import { Service } from "./service"
import type { Interface } from "./service"
import type {
  ArchitecturalSlice,
  CodegraphEdge,
  CodegraphFile,
  CodegraphNode,
  RepositoryContext,
  WorkspaceContext,
} from "../types"
import { Service as Git, defaultLayer as gitDefaultLayer } from "./git-service"

export type { Interface }
export { Service }

const KIND_PRIORITY: CodegraphNode["kind"][] = [
  "class",
  "function",
  "method",
  "type",
  "variable",
  "file",
]

const DOC_PATH_PATTERNS = [/\.md$/i, /^readme/i, /^changelog/i, /^contributing/i, /\/docs?\//i, /^design/i]
const CONFIG_PATH_PATTERNS = [/package\.json$/i, /tsconfig.*\.json$/i, /pyproject\.toml$/i, /cargo\.toml$/i, /go\.mod$/i, /pnpm-workspace\.yaml$/i, /bun\.fig\.toml$/i]

function kindRank(kind: CodegraphNode["kind"]): number {
  const idx = KIND_PRIORITY.indexOf(kind)
  return idx === -1 ? Infinity : idx
}

function isDocPath(path: string): boolean {
  return DOC_PATH_PATTERNS.some((p) => p.test(path))
}

function isConfigPath(path: string): boolean {
  return CONFIG_PATH_PATTERNS.some((p) => p.test(path))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const git = yield* Git

    const findSymbol = (input: {
      name: string
      kind?: CodegraphNode["kind"]
      file?: string
      exact?: boolean
    }): Effect.Effect<{ nodes: CodegraphNode[]; usedFallback: boolean }, never, never> =>
      Effect.gen(function* () {
        let fileID: string | undefined
        if (input.file) {
          const file = yield* repo.getFileByPath(input.file)
          fileID = file?.id
          if (!fileID) return { nodes: [], usedFallback: false }
        }

        // Try exact name search first
        const results = yield* repo.searchNodes({ name: input.name, kind: input.kind })
        let filtered = fileID ? results.filter((n) => n.fileID === fileID) : results

        let searchName = input.name
        let parentName: string | undefined

        // If no matches and the name contains a dot, fallback to class/method resolution
        if (filtered.length === 0 && input.name.includes(".")) {
          const parts = input.name.split(".")
          searchName = parts.pop()!
          parentName = parts.join(".")

          const splitResults = yield* repo.searchNodes({ name: searchName, kind: input.kind })
          let splitFiltered = fileID ? splitResults.filter((n) => n.fileID === fileID) : splitResults

          const allNodes = yield* repo.listAllNodes()
          const validFileIDs = new Set<string>()
          for (const node of allNodes) {
            if (node.name === parentName) {
              validFileIDs.add(node.fileID)
            }
          }
          splitFiltered = splitFiltered.filter((n) => validFileIDs.has(n.fileID))
          if (splitFiltered.length > 0) {
            filtered = splitFiltered
          }
        }

        if (input.exact) return { nodes: filtered, usedFallback: false }

        const exactMatch = filtered.find((n) => n.name === searchName || n.name === input.name)
        if (exactMatch) return { nodes: filtered, usedFallback: false }

        const all = yield* repo.listAllNodes()
        const prefixResults = all.filter((n) => n.name.startsWith(searchName) || n.name.startsWith(input.name))
        let prefixFiltered = fileID ? prefixResults.filter((n) => n.fileID === fileID) : prefixResults
        if (parentName) {
          const validFileIDs = new Set<string>()
          for (const node of all) {
            if (node.name === parentName) {
              validFileIDs.add(node.fileID)
            }
          }
          prefixFiltered = prefixFiltered.filter((n) => validFileIDs.has(n.fileID))
        }
        if (input.kind) return { nodes: prefixFiltered.filter((n) => n.kind === input.kind), usedFallback: false }

        // Fallback: recover Context.Service tag strings (e.g., user queries "MemoryRepo"
        // but the indexed name is "Service" because the parser extracted only the class
        // identifier from `class Service extends Context.Service<...>("@banyancode/MemoryRepo")`).
        const tagMatches = yield* repo.findSymbolsByServiceTag(input.name)
        if (tagMatches.length > 0) return { nodes: tagMatches, usedFallback: true }

        return { nodes: prefixFiltered, usedFallback: false }
      })

    const findSubsystem = (input: {
      query: string
      maxDepth?: number
    }): Effect.Effect<{ entry: CodegraphNode; related: CodegraphNode[] }, never, never> =>
      Effect.gen(function* () {
        const candidates = yield* repo.searchNodes({ name: input.query, limit: 20 })
        const sorted = candidates.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind))

        let entry: CodegraphNode | undefined
        if (sorted.length > 0) {
          entry = sorted[0]
        }

        if (!entry) {
          const all = yield* repo.listAllNodes()
          const matching = all.filter((n) => n.name.toLowerCase().includes(input.query.toLowerCase()))
          if (matching.length > 0) {
            entry = matching.slice().sort((a, b) => kindRank(a.kind) - kindRank(b.kind))[0]
          }
        }

        if (!entry) {
          const dummyEntry: CodegraphNode = {
            id: "",
            fileID: "",
            kind: "function",
            name: `no-match:${input.query}`,
            startLine: 0,
            endLine: 0,
          }
          return { entry: dummyEntry, related: [] }
        }

        const related = yield* walkSubsystem(entry.id, input.maxDepth ?? 3)
        return { entry, related }
      })

    const walkSubsystem = (nodeID: string, maxDepth: number): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const visited = new Set<string>([nodeID])
        const result: CodegraphNode[] = []
        const queue: Array<{ id: string; depth: number }> = [{ id: nodeID, depth: 0 }]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.depth >= maxDepth) continue

          const outgoing = yield* repo.edgesFrom(current.id)
          const incomingRaw = yield* repo.edgesTo(current.id)
          const incoming = incomingRaw.filter((e) => e.kind !== "imports" && e.kind !== "extends")

          const nextIDs: string[] = []
          for (const edge of [...outgoing, ...incoming]) {
            const nextID = edge.fromNodeID === current.id ? edge.toNodeID : edge.fromNodeID
            if (!visited.has(nextID)) {
              visited.add(nextID)
              nextIDs.push(nextID)
            }
          }

          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            result.push(...nodes)
            for (const id of nextIDs) {
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }

        return result
      })

    const findEntrypoints = (input: {
      feature: string
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const allFiles = yield* repo.listAllFiles()
        const featureLower = input.feature.toLowerCase()

        const matchingFiles = allFiles.filter((f) => f.path.toLowerCase().includes(featureLower))
        if (matchingFiles.length === 0) return []

        const fileIDs = new Set(matchingFiles.map((f) => f.id))
        const allNodes = yield* repo.listAllNodes()

        const entrypoints = allNodes.filter(
          (n) => fileIDs.has(n.fileID) && (n.kind === "function" || n.kind === "class" || n.kind === "method" || n.kind === "type"),
        )

        return entrypoints
      })

    const findTests = (input: {
      symbol: string
      symbolID?: string
    }): Effect.Effect<{ nodes: CodegraphNode[]; notFound: boolean }, never, never> =>
      Effect.gen(function* () {
        const allTestNodes = yield* repo.listNodesByKind("test")

        const doImportMatch = (symbolModule: string, symbolName: string) => {
          const matching: CodegraphNode[] = []
          for (const testNode of allTestNodes) {
            if (!testNode.code) continue
            const importsTarget = testNode.code.includes(symbolModule.replace(/\.ts$/, "")) ||
                                testNode.code.includes(symbolName)
            if (importsTarget) {
              matching.push(testNode)
            }
          }
          return matching
        }

        const doFallbackMatch = (symbolID: string): Effect.Effect<CodegraphNode[], never, never> =>
          Effect.gen(function* () {
            const allFiles = yield* repo.listAllFiles()
            const allNodes = yield* repo.listAllNodes()
            const testFilePatterns = [".test.ts", ".spec.ts", "test_", "_test.go", "_test.py", ".test.tsx", ".spec.tsx"]
            const testFiles = allFiles.filter((f) => {
              const lower = f.path.toLowerCase()
              return testFilePatterns.some((p) => lower.includes(p.toLowerCase()))
            })
            if (testFiles.length === 0) return []

            const testFileIDs = new Set(testFiles.map((f) => f.id))
            const testNodesFromFiles = allNodes.filter((n) => testFileIDs.has(n.fileID))
            if (testNodesFromFiles.length === 0) return []

            const relevantTests: CodegraphNode[] = []
            const outgoing = yield* repo.edgesFrom(symbolID)
            const testedBy = new Set(outgoing.filter((e) => e.kind === "tested_by").map((e) => e.toNodeID))

            for (const node of testNodesFromFiles) {
              if (testedBy.has(node.id)) {
                relevantTests.push(node)
                continue
              }
              const edges = yield* repo.edgesFrom(node.id)
              const references = edges.filter(
                (e) => e.toNodeID === symbolID && (e.kind === "calls" || e.kind === "references"),
              )
              if (references.length > 0) relevantTests.push(node)
            }

            return relevantTests
          })

        if (input.symbolID) {
          const targetNode = yield* repo.nodeByID(input.symbolID)
          if (!targetNode) return { nodes: [], notFound: true }
          const targetFile = yield* repo.getFile(targetNode.fileID)
          if (!targetFile) return { nodes: [], notFound: true }

          const symbolModule = targetFile.path
          const importMatching = doImportMatch(symbolModule, input.symbol)

          if (allTestNodes.length > 0) {
            if (importMatching.length > 0) {
              return { nodes: importMatching, notFound: false }
            }
            const fallback = yield* doFallbackMatch(input.symbolID)
            if (fallback.length > 0) {
              return { nodes: fallback, notFound: false }
            }
            return { nodes: [], notFound: false }
          }

          const fallback = yield* doFallbackMatch(input.symbolID)
          return { nodes: fallback, notFound: fallback.length === 0 }
        }

        const symbolResult = yield* findSymbol({ name: input.symbol })
        if (symbolResult.nodes.length === 0) {
          return { nodes: [], notFound: true }
        }

        const searchName = input.symbol.includes(".") ? input.symbol.split(".").pop()! : input.symbol
        const exactMatch = symbolResult.nodes.find((n) => n.name === searchName)
        const symbolID = (exactMatch ?? symbolResult.nodes[0])!.id

        const targetNode = yield* repo.nodeByID(symbolID)
        if (!targetNode) return { nodes: [], notFound: true }
        const targetFile = yield* repo.getFile(targetNode.fileID)
        if (!targetFile) return { nodes: [], notFound: true }

        const symbolModule = targetFile.path
        const importMatching = doImportMatch(symbolModule, input.symbol)

        if (allTestNodes.length > 0) {
          if (importMatching.length > 0) {
            return { nodes: importMatching, notFound: false }
          }
          const fallback = yield* doFallbackMatch(symbolID)
          if (fallback.length > 0) {
            return { nodes: fallback, notFound: false }
          }
          return { nodes: [], notFound: false }
        }

        const fallback = yield* doFallbackMatch(symbolID)
        return { nodes: fallback, notFound: fallback.length === 0 }
      })

    const findRelated = (input: {
      nodeID: string
      depth?: number
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const maxDepth = input.depth ?? 2
        const visited = new Set<string>([input.nodeID])
        const result: CodegraphNode[] = []
        const queue: Array<{ id: string; depth: number }> = [{ id: input.nodeID, depth: 0 }]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.depth >= maxDepth) continue

          const outgoing = yield* repo.edgesFrom(current.id)
          const incoming = yield* repo.edgesTo(current.id)

          const nextIDs: string[] = []
          for (const edge of [...outgoing, ...incoming]) {
            const nextID = edge.fromNodeID === current.id ? edge.toNodeID : edge.fromNodeID
            if (!visited.has(nextID)) {
              visited.add(nextID)
              nextIDs.push(nextID)
            }
          }

          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            result.push(...nodes)
            for (const id of nextIDs) {
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }

        return result
      })

    const query = (input: {
      query: string
      limit?: number
      workspace?: WorkspaceContext
    }): Effect.Effect<RepositoryContext, never, never> =>
      Effect.gen(function* () {
        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()

        const symbolResult = yield* findSymbol({ name: input.query })
        const fileByPath = yield* repo.getFileByPath(input.query)
        const fileMatches: CodegraphNode[] = fileByPath
          ? allNodes.filter((n) => n.fileID === fileByPath.id)
          : []

        const seen = new Set<string>()
        const symbols: CodegraphNode[] = []
        for (const n of [...symbolResult.nodes, ...fileMatches]) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            symbols.push(n)
          }
        }

        const testsResult = symbols.length > 0 ? yield* findTests({ symbol: input.query }) : { nodes: [] as CodegraphNode[], notFound: true }

        const relatedNodes: CodegraphNode[] = []
        for (const sym of symbols) {
          const related = yield* findRelated({ nodeID: sym.id, depth: 1 })
          for (const r of related) {
            if (!seen.has(r.id)) {
              seen.add(r.id)
              relatedNodes.push(r)
            }
          }
        }

        const graphNodeIDs = new Set<string>([...seen])
        const graphEdges: CodegraphEdge[] = []
        for (const sym of [...symbols, ...relatedNodes]) {
          const outgoing = yield* repo.edgesFrom(sym.id)
          const incoming = yield* repo.edgesTo(sym.id)
          for (const edge of outgoing) {
            graphEdges.push(edge)
            graphNodeIDs.add(edge.toNodeID)
          }
          for (const edge of incoming) {
            graphEdges.push(edge)
            graphNodeIDs.add(edge.fromNodeID)
          }
        }
        const graphNodesList = graphNodeIDs.size > 0 ? yield* repo.nodesByIDs([...graphNodeIDs]) : []

        const isDegraded = symbols.length === 0
        const diagnostics: { kind: string; message: string }[] = []
        if (isDegraded) {
          diagnostics.push({
            kind: "symbol-not-found",
            message: `No symbol matched "${input.query}". The graph may be stale — run /codegraph-build --force.`,
          })
        }

        const graphFileIDs = new Set<string>(
          graphNodesList.map((n) => n.fileID).filter((id): id is string => Boolean(id))
        )

        const docs = isDegraded
          ? []
          : allFiles.filter((f) => graphFileIDs.has(f.id) && isDocPath(f.path))
        const configs = isDegraded
          ? []
          : allFiles.filter((f) => graphFileIDs.has(f.id) && isConfigPath(f.path))
        const files = isDegraded
          ? []
          : allFiles.filter((f) => graphFileIDs.has(f.id))

        const recentCommits = yield* git.recentCommits({
          limit: input.limit ?? 10,
          ...(input.workspace?.worktree ? { cwd: input.workspace.worktree } : {}),
        })
        const ownership = new Map<string, number>()

        return {
          status: isDegraded ? "failed" : "success",
          reason: isDegraded ? `No matching symbols found for query "${input.query}"` : undefined,
          recoveryHint: isDegraded ? `Run /codegraph-build --force to refresh the index, or use code_find with intent='definition' to search broadly.` : undefined,
          degraded: isDegraded,
          fallbackUsed: symbolResult.usedFallback,
          query: input.query,
          symbols,
          files,
          graph: { nodes: graphNodesList, edges: graphEdges },
          tests: testsResult.nodes.filter((n) => graphFileIDs.has(n.fileID)),
          docs,
          configs,
          git: { recentCommits, ownership },
          workspace: input.workspace,
          diagnostics,
          ranking: {
            score: 0,
            signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 },
          },
        } satisfies RepositoryContext
      })

    const slice = (ctx: RepositoryContext): Effect.Effect<ArchitecturalSlice, never, never> =>
      Effect.gen(function* () {
        const entrypoints = ctx.symbols.filter(
          (n) => n.kind === "function" || n.kind === "class" || n.kind === "route" || n.kind === "method",
        )
        const importantSymbols = ctx.symbols.filter(
          (n) => n.kind !== "variable" && n.kind !== "type" && n.kind !== "file" && n.kind !== "generated",
        )
        const routes = ctx.symbols.filter((n) => n.kind === "route")
        const symbolNames = new Set(ctx.symbols.map((s) => s.name))
        const relatedTests = ctx.tests.filter((t) => {
          if (symbolNames.has(t.name)) return true
          return ctx.symbols.length > 0
        })

        const summaryParts: string[] = []
        summaryParts.push(`Query "${ctx.query}"`)
        if (ctx.symbols.length > 0) summaryParts.push(`${ctx.symbols.length} symbols`)
        if (ctx.tests.length > 0) summaryParts.push(`${ctx.tests.length} tests`)
        if (ctx.docs.length > 0) summaryParts.push(`${ctx.docs.length} docs`)
        if (ctx.configs.length > 0) summaryParts.push(`${ctx.configs.length} configs`)
        if (ctx.graph.edges.length > 0) summaryParts.push(`${ctx.graph.edges.length} edges`)
        const summary = summaryParts.join(" — ")

        return {
          status: ctx.status,
          reason: ctx.reason,
          recoveryHint: ctx.recoveryHint,
          degraded: ctx.degraded,
          fallbackUsed: ctx.fallbackUsed,
          summary,
          entrypoints,
          importantSymbols,
          relatedTests: ctx.tests,
          relatedDocs: ctx.docs,
          configs: ctx.configs,
          routes,
          dependencies: [] as readonly { name: string; version?: string }[],
        } satisfies ArchitecturalSlice
      })

    const explain = (input: {
      symbol: string
      workspace?: WorkspaceContext
    }): Effect.Effect<ArchitecturalSlice, never, never> =>
      Effect.gen(function* () {
        const ctx = yield* query({ query: input.symbol, workspace: input.workspace })
        return yield* slice(ctx)
      })

    const impact = (input: {
      path: string
      workspace?: WorkspaceContext
    }): Effect.Effect<ArchitecturalSlice, never, never> =>
      Effect.gen(function* () {
        const ctx = yield* query({ query: input.path, workspace: input.workspace })
        const slc = yield* slice(ctx)
        const file = yield* repo.getFileByPath(input.path)
        if (file) {
          const dependents = yield* findEntrypoints({ feature: file.path.split("/").pop() ?? file.path })
          const seen = new Set(slc.importantSymbols.map((n) => n.id))
          const expanded = [...slc.importantSymbols]
          for (const dep of dependents) {
            if (!seen.has(dep.id)) {
              seen.add(dep.id)
              expanded.push(dep)
            }
          }
          return { ...slc, importantSymbols: expanded }
        }
        return slc
      })

    const trace = (input: {
      symbol: string
      depth?: number
      workspace?: WorkspaceContext
    }): Effect.Effect<ArchitecturalSlice, never, never> =>
      Effect.gen(function* () {
        const ctx = yield* query({ query: input.symbol, workspace: input.workspace })
        const slc = yield* slice(ctx)

        if (ctx.symbols.length > 0) {
          const anchor = ctx.symbols[0]!
          const downstream = yield* findRelated({ nodeID: anchor.id, depth: input.depth ?? 2 })
          const seen = new Set([...slc.entrypoints, ...slc.importantSymbols].map((n) => n.id))
          const expanded = [...slc.entrypoints]
          for (const dep of downstream) {
            if (dep.kind === "function" || dep.kind === "class" || dep.kind === "method") {
              if (!seen.has(dep.id)) {
                seen.add(dep.id)
                expanded.push(dep)
              }
            }
          }
          return { ...slc, entrypoints: expanded }
        }
        return slc
      })

    const tests = (input: { symbol: string }): Effect.Effect<{ tests: readonly CodegraphNode[]; notFound: boolean }, never, never> =>
      Effect.gen(function* () {
        const result = yield* findTests(input)
        return { tests: result.nodes, notFound: result.notFound }
      })

    const symbols = (input: { query: string; limit?: number }): Effect.Effect<readonly CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const result = yield* findSymbol({ name: input.query })
        return result.nodes
      })

    const relationships = (input: {
      nodeID?: string
      path?: string
      depth?: number
    }): Effect.Effect<readonly CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        if (input.path && !input.nodeID) {
          // Resolve the file by path, then aggregate relationships across every
          // node belonging to that file. This is the path-based fallback for
          // tools that don't have an exact codegraph nodeID handy.
          const file = yield* repo.getFileByPath(input.path)
          if (!file) return []
          const fileNodes = yield* repo.listNodesByFile(file.id)
          const seen = new Set<string>()
          const result: CodegraphNode[] = []
          for (const anchor of fileNodes) {
            const related = yield* findRelated({ nodeID: anchor.id, depth: input.depth ?? 1 })
            for (const n of related) {
              if (!seen.has(n.id)) {
                seen.add(n.id)
                result.push(n)
              }
            }
          }
          return result
        }
        if (!input.nodeID) return []
        return yield* findRelated({ nodeID: input.nodeID, depth: input.depth })
      })

    const findOwner = (input: { path: string; cwd?: string }): Effect.Effect<{ owner?: string; count: number }, never, never> =>
      Effect.gen(function* () {
        return yield* git.owners(input)
      })

    return Service.of({
      query,
      slice,
      explain,
      impact,
      trace,
      tests,
      symbols,
      relationships,
      findOwner,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(gitDefaultLayer), Layer.provide(CodegraphRepo.defaultLayer))
