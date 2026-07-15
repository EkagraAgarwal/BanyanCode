import { Effect, Layer } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import { resolveGraphTargetPure } from "../symbol-resolver"
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

// Phase 2 ranking heuristic for transitive dependents of a trace anchor.
//
//   score = (1 / depth) * ln(1 + inDegree) * (isEntrypoint ? 2 : 1)
//
// `inDegree` and `isEntrypoint` are read from optional CodegraphNode fields
// when the columns are populated (Phase 3). Until then the function falls
// back to `score = (1 / depth) * (isEntrypointHeuristic(node) ? 2 : 1)` so
// callers see stable, depth-preferred ordering before the indexer
// migration lands.
const ENTRYPOINT_PATH_PATTERNS = [
  /\/commands?\//i,
  /\/cli\//i,
  /\/routes?\//i,
  /\/handlers?\//i,
  /\/bin\//i,
  /\/scripts?\//i,
]
// Match either the literal name (e.g. "handler", "main") or a name that
// clearly looks like one ("cli-handler", "request-handler", "mainFn").
const ENTRYPOINT_NAME_HINTS = /(handler|^main$|mainFn|mainHandler|^route$|^cmd$|^command$|^setup$|^bootstrap$)/i
const ROUTE_REGEX_HINT = /\b(app|router|fastify|instance)\s*\.\s*(get|post|put|delete|patch|head|options|trace)\s*\(/i

const isEntrypointHeuristic = (node: CodegraphNode, filePath?: string): boolean => {
  if (ENTRYPOINT_NAME_HINTS.test(node.name)) return true
  if (filePath && ENTRYPOINT_PATH_PATTERNS.some((p) => p.test(filePath))) return true
  const sig = node.signature
  if (sig && ENTRYPOINT_PATH_PATTERNS.some((p) => p.test(sig))) return true
  if (node.code && ROUTE_REGEX_HINT.test(node.code)) return true
  return false
}

const readIsEntrypoint = (node: CodegraphNode, filePath?: string): boolean => {
  const raw = (node as CodegraphNode & { isEntrypoint?: number | boolean | undefined }).isEntrypoint
  if (raw) return true
  return isEntrypointHeuristic(node, filePath)
}

const readInDegree = (node: CodegraphNode): number => {
  const raw = (node as CodegraphNode & { inDegree?: number }).inDegree
  return typeof raw === "number" && raw > 0 ? raw : 1
}

// Score one transitive dependent. Higher score wins.
//   full:  (1 / depth) * ln(1 + inDegree) * (isEntrypoint ? 2 : 1)
//   fallback (pre-Phase-3): (1 / depth) * (isEntrypoint ? 2 : 1)
const scoreTransitiveNode = (node: CodegraphNode, depth: number, filePath?: string): number => {
  const isEp = readIsEntrypoint(node, filePath)
  const inDegree = readInDegree(node)
  const inDegreeWeight = (node as CodegraphNode & { inDegree?: number }).inDegree ? Math.log(1 + inDegree) : 1
  return (1 / depth) * inDegreeWeight * (isEp ? 2 : 1)
}

const rankTransitiveDependents = (
  tagged: ReadonlyArray<{ readonly node: CodegraphNode; readonly depth: number }>,
  filePathByID: ReadonlyMap<string, string> = new Map(),
): CodegraphNode[] => {
  return [...tagged]
    .map((t) => ({
      node: t.node,
      depth: t.depth,
      score: scoreTransitiveNode(t.node, t.depth, filePathByID.get(t.node.fileID)),
    }))
    .sort((a, b) => b.score - a.score || a.depth - b.depth)
    .map((t) => t.node)
}

type EdgeDirection = "callers" | "dependencies"

const CALLER_EDGE_KINDS: ReadonlySet<CodegraphEdge["kind"]> = new Set(["calls", "references"])
const DEPENDENCY_EDGE_KINDS: ReadonlySet<CodegraphEdge["kind"]> = new Set([
  "calls",
  "references",
  "imports",
  "extends",
])

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
      workspace?: WorkspaceContext
    }): Effect.Effect<{ nodes: CodegraphNode[]; usedFallback: boolean; ambiguity?: { total: number; kept: number } }, never, never> =>
      Effect.gen(function* () {
        let fileID: string | undefined
        if (input.file) {
          const file = yield* repo.getFileByPath(input.file)
          fileID = file?.id
          if (!fileID) return { nodes: [], usedFallback: false }
        }

        const result = yield* resolveGraphTargetPure(repo as never, {
          target: input.name,
          kind: input.kind,
          ...(fileID ? { fileID } : {}),
        })

        if (result._tag === "Miss") return { nodes: [], usedFallback: false }

        let nodes = [...result.value.candidates]
        const derivation = result.value.derivation
        const hasFocusDirs = input.workspace?.focusDirs && input.workspace.focusDirs.length > 0

        if (input.exact) {
          nodes = nodes.filter((n) => n.name === input.name)
        }

        if (hasFocusDirs) {
          const focusSet = new Set(
            input.workspace!.focusDirs.map((d) => d.replace(/\\/g, "/")),
          )
          const focused: CodegraphNode[] = []
          const unfocused: CodegraphNode[] = []

          for (const node of nodes) {
            const file = yield* repo.getFile(node.fileID)
            if (!file) {
              unfocused.push(node)
              continue
            }
            const normalizedPath = file.path.replace(/\\/g, "/")
            const isFocused = [...focusSet].some(
              (prefix) =>
                normalizedPath === prefix ||
                normalizedPath.startsWith(prefix + "/"),
            )
            if (isFocused) {
              focused.push(node)
            } else {
              unfocused.push(node)
            }
          }

          if (focused.length > 0) {
            return {
              nodes: focused,
              usedFallback: derivation === "tag-fallback",
            }
          }
          return {
            nodes: [...focused, ...unfocused],
            usedFallback: derivation === "tag-fallback",
            ambiguity: { total: nodes.length, kept: 0 },
          }
        }

        const usedFallback = derivation === "tag-fallback"

        if (nodes.length > 1 && derivation === "name-exact") {
          const PRODUCT_PREFIXES = [
            "packages/opencode",
            "packages/core",
            "packages/tui",
          ]
          const UI_EXCLUDED = [
            "packages/web",
            "packages/app",
            "packages/desktop",
            "packages/storybook",
          ]

          const filePathByNodeID = new Map<string, string>()
          for (const node of nodes) {
            const file = yield* repo.getFile(node.fileID)
            if (file) filePathByNodeID.set(node.id, file.path.replace(/\\/g, "/"))
          }

          const productNodes = nodes.filter((n) => {
            const path = filePathByNodeID.get(n.id) ?? ""
            return PRODUCT_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))
          })
          const uiNodes = nodes.filter((n) => {
            const path = filePathByNodeID.get(n.id) ?? ""
            return UI_EXCLUDED.some((p) => path === p || path.startsWith(p + "/"))
          })

          if (productNodes.length > 0) {
            return {
              nodes: productNodes,
              usedFallback,
              ambiguity: { total: nodes.length, kept: productNodes.length },
            }
          }

          return {
            nodes,
            usedFallback,
            ambiguity: { total: nodes.length, kept: nodes.length },
          }
        }

        return {
          nodes,
          usedFallback: derivation === "tag-fallback",
        }
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

          // Edge-based match wins over substring match when we already have a
          // nodeID — substring is only useful when there's no graph to lean on.
          const edgeBased = yield* doFallbackMatch(input.symbolID)
          if (edgeBased.length > 0) {
            return { nodes: edgeBased, notFound: false }
          }

          const symbolModule = targetFile.path
          const importMatching = doImportMatch(symbolModule, input.symbol)
          if (importMatching.length > 0) {
            return { nodes: importMatching, notFound: false }
          }
          return { nodes: [], notFound: false }
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

        // Same ordering for the resolved path: edge-based first.
        const edgeBased = yield* doFallbackMatch(symbolID)
        if (edgeBased.length > 0) {
          return { nodes: edgeBased, notFound: false }
        }

        const symbolModule = targetFile.path
        const importMatching = doImportMatch(symbolModule, input.symbol)
        if (importMatching.length > 0) {
          return { nodes: importMatching, notFound: false }
        }
        return { nodes: [], notFound: false }
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
          for (const edge of outgoing) {
            if (!DEPENDENCY_EDGE_KINDS.has(edge.kind)) continue
            if (!visited.has(edge.toNodeID)) {
              visited.add(edge.toNodeID)
              nextIDs.push(edge.toNodeID)
            }
          }
          for (const edge of incoming) {
            if (!CALLER_EDGE_KINDS.has(edge.kind)) continue
            if (!visited.has(edge.fromNodeID)) {
              visited.add(edge.fromNodeID)
              nextIDs.push(edge.fromNodeID)
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

    // Depth-tagged BFS. Each discovered node carries the per-node hop distance
    // from the anchor (depth=1 means the anchor calls/touches it directly).
    // Phase 2 ranking consumes these depths to score transitive dependents.
    // Directional-but-tolerant: outgoing uses all dependency kinds, incoming
    // uses only caller kinds (calls/references).
    const findRelatedWithDepth = (input: {
      nodeID: string
      depth?: number
    }): Effect.Effect<Array<{ readonly node: CodegraphNode; readonly depth: number }>, never, never> =>
      Effect.gen(function* () {
        const maxDepth = input.depth ?? 2
        const visited = new Set<string>([input.nodeID])
        const result: Array<{ node: CodegraphNode; depth: number }> = []
        const queue: Array<{ id: string; depth: number }> = [{ id: input.nodeID, depth: 0 }]

        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.depth >= maxDepth) continue

          const outgoing = yield* repo.edgesFrom(current.id)
          const incoming = yield* repo.edgesTo(current.id)

          const nextIDs: string[] = []
          for (const edge of outgoing) {
            if (!DEPENDENCY_EDGE_KINDS.has(edge.kind)) continue
            if (!visited.has(edge.toNodeID)) {
              visited.add(edge.toNodeID)
              nextIDs.push(edge.toNodeID)
            }
          }
          for (const edge of incoming) {
            if (!CALLER_EDGE_KINDS.has(edge.kind)) continue
            if (!visited.has(edge.fromNodeID)) {
              visited.add(edge.fromNodeID)
              nextIDs.push(edge.fromNodeID)
            }
          }

          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            for (const node of nodes) {
              result.push({ node, depth: current.depth + 1 })
            }
            for (const id of nextIDs) {
              queue.push({ id, depth: current.depth + 1 })
            }
          }
        }

        return result
      })

    // Strict directional BFS: incoming calls/references only.
    const findCallers = (input: {
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

          const incoming = yield* repo.edgesTo(current.id)
          const nextIDs: string[] = []
          for (const edge of incoming) {
            if (!CALLER_EDGE_KINDS.has(edge.kind)) continue
            const nextID = edge.fromNodeID
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

    // Strict directional BFS: outgoing calls/references/imports/extends only.
    const findDependencies = (input: {
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
          const nextIDs: string[] = []
          for (const edge of outgoing) {
            if (!DEPENDENCY_EDGE_KINDS.has(edge.kind)) continue
            const nextID = edge.toNodeID
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

        const symbolResult = yield* findSymbol({ name: input.query, workspace: input.workspace })
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
        const diagnostics: { kind: string; message: string; candidates?: readonly CodegraphNode[] }[] = []
        if (isDegraded) {
          diagnostics.push({
            kind: "symbol-not-found",
            message: `No symbol matched "${input.query}". The graph may be stale — run /codegraph-build --force.`,
          })
        } else if (symbolResult.ambiguity) {
          const candidateFiles: CodegraphNode[] = []
          for (const n of symbolResult.nodes) {
            const file = yield* repo.getFile(n.fileID)
            if (file) candidateFiles.push(n)
          }
          diagnostics.push({
            kind: "ambiguous-symbol",
            message: "Multiple exact-name matches found; pass focusDirs to disambiguate.",
            candidates: candidateFiles,
          })
        }

        const graphFileIDs = new Set<string>(
          graphNodesList.map((n) => n.fileID).filter((id): id is string => Boolean(id))
        )

        // Tighter bucket scope: only the files that *contain* matched symbols
        // or their direct related nodes (depth=1). Previously `graphFileIDs`
        // was built by expanding to every edge endpoint reachable from those
        // symbols (including `imports`/`extends`), which balloons to
        // near-repo-wide for common queries.
        const bucketFileIDs = new Set<string>(
          [...symbols, ...relatedNodes]
            .map((n) => n.fileID)
            .filter((id): id is string => Boolean(id))
        )

        const docs = isDegraded
          ? []
          : allFiles.filter((f) => bucketFileIDs.has(f.id) && isDocPath(f.path))
        const configs = isDegraded
          ? []
          : allFiles.filter((f) => bucketFileIDs.has(f.id) && isConfigPath(f.path))
        const files = isDegraded
          ? []
          : allFiles.filter((f) => bucketFileIDs.has(f.id))

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
          tests: testsResult.nodes.filter((n) => bucketFileIDs.has(n.fileID)),
          docs,
          configs,
          git: { recentCommits, ownership },
          workspace: input.workspace,
          diagnostics,
          ranking: {
            score: 0,
            signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 },
          },
          ...(symbolResult.ambiguity ? { ambiguity: symbolResult.ambiguity } : {}),
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

        const defaultLimit = 25

        const directCallersSet = new Map<string, CodegraphNode>()
        const transitiveSet = new Map<string, CodegraphNode>()
        const dependencySet = new Map<string, { name: string; version?: string }>()

        if (ctx.symbols.length > 0) {
          const anchorIDs = ctx.symbols.slice(0, 1).map((s) => s.id)
          for (const anchorID of anchorIDs) {
            const callers = yield* findCallers({ nodeID: anchorID, depth: 1 })
            for (const c of callers) directCallersSet.set(c.id, c)
            const transitive = yield* findCallers({ nodeID: anchorID, depth: 3 })
            for (const t of transitive) {
              if (!directCallersSet.has(t.id)) transitiveSet.set(t.id, t)
            }
            const deps = yield* findDependencies({ nodeID: anchorID, depth: 1 })
            for (const d of deps) {
              if (d.kind === "function" || d.kind === "class" || d.kind === "method" || d.kind === "type") {
                dependencySet.set(d.name, { name: d.name })
              }
            }
          }
        }

        const directCallers = [...directCallersSet.values()].slice(0, defaultLimit)
        const transitiveDependents = [...transitiveSet.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, defaultLimit)

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
          dependencies: [...dependencySet.values()],
          directCallers,
          transitiveDependents,
          moreAvailable:
            directCallersSet.size + transitiveSet.size > defaultLimit
              ? {
                  callers: directCallersSet.size - directCallers.length,
                  dependents: transitiveSet.size - transitiveDependents.length,
                }
              : undefined,
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
      limit?: number
      workspace?: WorkspaceContext
    }): Effect.Effect<ArchitecturalSlice, never, never> =>
      Effect.gen(function* () {
        const ctx = yield* query({ query: input.symbol, workspace: input.workspace })
        const slc = yield* slice(ctx)

        if (ctx.symbols.length === 0) {
          return {
            ...slc,
            directCallers: [] as readonly CodegraphNode[],
            transitiveDependents: [] as readonly CodegraphNode[],
          }
        }

        const anchor = ctx.symbols[0]!
        const maxDepth = input.depth ?? 2
        const limit = Math.max(1, Math.min(1000, input.limit ?? 50))

        const tagged = yield* findRelatedWithDepth({ nodeID: anchor.id, depth: maxDepth })

        const isCodeLike = (k: CodegraphNode["kind"]) =>
          k === "function" || k === "class" || k === "method"

        const directCallers: CodegraphNode[] = []
        const transitiveTagged: Array<{ node: CodegraphNode; depth: number }> = []

        for (const t of tagged) {
          if (!isCodeLike(t.node.kind)) continue
          if (t.depth === 1) {
            directCallers.push(t.node)
          } else {
            transitiveTagged.push(t)
          }
        }

        // Build a fileID -> path lookup so the ranker can match path-based
        // entrypoint heuristics without making N parallel getFile calls.
        const fileIDs = new Set<string>()
        for (const t of transitiveTagged) fileIDs.add(t.node.fileID)
        const filePathByID = new Map<string, string>()
        for (const id of fileIDs) {
          const file = yield* repo.getFile(id)
          if (file) filePathByID.set(id, file.path)
        }

        const rankedTransitive = rankTransitiveDependents(transitiveTagged, filePathByID)
        let moreDependents = 0
        let visibleTransitive: readonly CodegraphNode[] = rankedTransitive
        if (rankedTransitive.length > limit) {
          visibleTransitive = rankedTransitive.slice(0, limit)
          moreDependents = rankedTransitive.length - limit
        }

        return {
          ...slc,
          directCallers,
          transitiveDependents: visibleTransitive,
          entrypoints: directCallers,
          moreAvailable: moreDependents > 0 ? { dependents: moreDependents } : undefined,
        } satisfies ArchitecturalSlice
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
