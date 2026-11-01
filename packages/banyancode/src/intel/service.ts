import { Effect } from "effect"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { makeGit, type GitPort } from "./git.js"
import { isConfigPath, isDocPath, isTestFilePath } from "./paths.js"
import { CALLER_EDGE_KINDS, DEPENDENCY_EDGE_KINDS, resolveFileByPath, resolveGraphTarget } from "./resolve.js"
import type {
  ArchitecturalSlice,
  Diagnostic,
  GraphEdge,
  GraphFile,
  GraphMeta,
  GraphNode,
  Ranking,
  RepositoryContext,
  TestDerivation,
  WorkspaceContext,
} from "./types.js"

/**
 * Repository intelligence service, ported from v1
 * `packages/core/src/banyancode/repository-intelligence/layer.ts`.
 *
 * The graph is reached exclusively through `CodegraphPort`; git through a
 * small `GitPort`. Nothing here imports `src/codegraph`.
 */

export interface QueryInput {
  readonly query: string
  readonly limit?: number
  readonly workspace?: WorkspaceContext
}

export interface ExplainInput {
  readonly symbol: string
  readonly workspace?: WorkspaceContext
}

export interface ImpactInput {
  readonly path: string
  readonly workspace?: WorkspaceContext
}

export interface TraceInput {
  readonly symbol: string
  readonly depth?: number
  readonly limit?: number
  readonly workspace?: WorkspaceContext
}

export interface TestsResult {
  readonly tests: readonly GraphNode[]
  readonly notFound: boolean
  readonly derivation: TestDerivation
}

export interface Interface {
  readonly query: (input: QueryInput) => Effect.Effect<RepositoryContext>
  readonly slice: (ctx: RepositoryContext) => Effect.Effect<ArchitecturalSlice>
  readonly explain: (input: ExplainInput) => Effect.Effect<ArchitecturalSlice>
  readonly impact: (input: ImpactInput) => Effect.Effect<ArchitecturalSlice>
  readonly trace: (input: TraceInput) => Effect.Effect<ArchitecturalSlice>
  readonly tests: (input: { symbol: string; limit?: number }) => Effect.Effect<TestsResult>
  readonly symbols: (input: { query: string; limit?: number }) => Effect.Effect<readonly GraphNode[]>
  readonly relationships: (input: { nodeID?: string; path?: string; depth?: number }) => Effect.Effect<readonly GraphNode[]>
  readonly findOwner: (input: { path: string; cwd?: string }) => Effect.Effect<{ owner?: string; count: number }>
  readonly meta: () => Effect.Effect<GraphMeta | undefined>
}

const PRODUCT_PREFIXES = ["packages/opencode", "packages/core", "packages/tui", "packages/banyancode"]

const ENTRYPOINT_PATH_PATTERNS = [
  /\/commands?\//i,
  /\/cli\//i,
  /\/routes?\//i,
  /\/handlers?\//i,
  /\/bin\//i,
  /\/scripts?\//i,
]
const ENTRYPOINT_NAME_HINTS = /(handler|^main$|mainFn|mainHandler|^route$|^cmd$|^command$|^setup$|^bootstrap$)/i
const ROUTE_REGEX_HINT = /\b(app|router|fastify|instance)\s*\.\s*(get|post|put|delete|patch|head|options|trace)\s*\(/i

const isEntrypointHeuristic = (node: GraphNode, filePath?: string): boolean => {
  if (ENTRYPOINT_NAME_HINTS.test(node.name)) return true
  if (filePath && ENTRYPOINT_PATH_PATTERNS.some((pattern) => pattern.test(filePath))) return true
  const signature = node.signature
  if (signature && ENTRYPOINT_PATH_PATTERNS.some((pattern) => pattern.test(signature))) return true
  if (node.code && ROUTE_REGEX_HINT.test(node.code)) return true
  return false
}

const readIsEntrypoint = (node: GraphNode, filePath?: string): boolean =>
  (node.isEntrypoint === 1 ? true : false) || isEntrypointHeuristic(node, filePath)

const readInDegree = (node: GraphNode): number =>
  typeof node.inDegree === "number" && node.inDegree > 0 ? node.inDegree : 1

const scoreTransitiveNode = (node: GraphNode, depth: number, filePath?: string): number => {
  const entrypoint = readIsEntrypoint(node, filePath) ? 2 : 1
  const inDegreeWeight = node.inDegree ? Math.log(1 + readInDegree(node)) : 1
  return (1 / depth) * inDegreeWeight * entrypoint
}

const rankTransitiveDependents = (
  tagged: ReadonlyArray<{ readonly node: GraphNode; readonly depth: number }>,
  filePathByID: ReadonlyMap<string, string>,
): GraphNode[] =>
  [...tagged]
    .map((entry) => ({
      node: entry.node,
      depth: entry.depth,
      score: scoreTransitiveNode(entry.node, entry.depth, filePathByID.get(entry.node.fileID)),
    }))
    .sort((a, b) => b.score - a.score || a.depth - b.depth)
    .map((entry) => entry.node)

// v1 `ranking/rank.ts` formula, reduced to the features the v2 pipeline can
// populate without inventing zeros: exact name, prefix/snake/camel shape,
// bm25 position, graph degree, focusDirs proximity.
const rankCandidates = (
  candidates: ReadonlyArray<{
    readonly node: GraphNode
    readonly query: string
    readonly exact: boolean
    readonly bm25Score: number
    readonly workspaceProximity: number
  }>,
): Ranking => {
  let best: { score: number; signals: Ranking["signals"] } | undefined
  for (const entry of candidates) {
    const lower = entry.query.toLowerCase()
    const name = entry.node.name.toLowerCase()
    const prefix = name.startsWith(lower) ? 5 : 0
    const camel = /[a-z][A-Z]/.test(entry.node.name) && name.replace(/[^a-z0-9]/g, "").includes(lower.replace(/[^a-z0-9]/g, "")) ? 4 : 0
    const snake = entry.node.name.includes("_") && name.includes(lower) ? 4 : 0
    const exact = entry.exact ? 10 : 0
    const graph = Math.min(entry.node.inDegree ?? 0, 10) * 0.5
    const workspaceSignal = entry.workspaceProximity * 0.5
    const symbol = prefix + camel + snake
    const score = exact + symbol + entry.bm25Score * 8 + graph + workspaceSignal
    if (!best || score > best.score) {
      best = { score, signals: { exact, symbol, graph, git: 0, workspace: workspaceSignal } }
    }
  }
  return best ?? { score: 0, signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 } }
}

const normalizeFocusDirs = (focusDirs: readonly string[], indexedRoot?: string): readonly string[] => {
  if (focusDirs.length === 0) return focusDirs
  const root = indexedRoot ? indexedRoot.replace(/\\/g, "/").replace(/\/+$/, "") : undefined
  return focusDirs.map((dir) => {
    const cleaned = dir.replace(/\\/g, "/").trim()
    if (!cleaned) return cleaned
    if (root && cleaned === root) return ""
    if (root && cleaned.startsWith(root + "/")) return cleaned.slice(root.length + 1)
    return cleaned
  })
}

const pathMatchesFocusDirs = (normalizedPath: string, normalizedFocusDirs: readonly string[]): boolean => {
  if (normalizedFocusDirs.length === 0) return true
  return normalizedFocusDirs.some((prefix) =>
    prefix.length === 0 ? true : normalizedPath === prefix || normalizedPath.startsWith(prefix + "/"),
  )
}

type QueryContext = {
  readonly allFiles: readonly GraphFile[]
  readonly allNodesLight: readonly GraphNode[]
  readonly meta: GraphMeta | undefined
  readonly pathByID: ReadonlyMap<string, string>
}

export interface Options {
  readonly git?: GitPort
}

export const make = (port: CodegraphPort, options: Options = {}): Interface => {
  const git = options.git ?? makeGit()

  const findSymbol = (
    input: { name: string; kind?: GraphNode["kind"]; file?: string; exact?: boolean; workspace?: WorkspaceContext },
    ctx?: QueryContext,
  ): Effect.Effect<{ nodes: GraphNode[]; usedFallback: boolean; ambiguity?: { total: number; kept: number } }> =>
    Effect.gen(function* () {
      const meta = ctx?.meta ?? (yield* port.meta())
      let fileID: string | undefined
      if (input.file) {
        const file = yield* resolveFileByPath(port, input.file, meta?.indexedRoot, ctx?.allFiles)
        fileID = file?.id
        if (!fileID) return { nodes: [], usedFallback: false }
      }

      const resolved = yield* resolveGraphTarget(port, {
        target: input.name,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(fileID ? { fileID } : {}),
      })
      if (resolved._tag === "Miss") return { nodes: [], usedFallback: false }

      let nodes = [...resolved.value.candidates]
      if (input.exact) nodes = nodes.filter((node) => node.name === input.name)
      const rawFocusDirs = input.workspace?.focusDirs ?? []
      const usedFallback = resolved.value.derivation === "tag-fallback"

      if (rawFocusDirs.length === 0) {
        if (nodes.length > 1 && resolved.value.derivation === "name-exact") {
          const allFiles = ctx?.allFiles ?? (yield* port.listFiles())
          const pathByID = new Map(allFiles.map((file) => [file.id, file.path.replace(/\\/g, "/")]))
          const productNodes = nodes.filter((node) => {
            const path = pathByID.get(node.fileID) ?? ""
            return PRODUCT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
          })
          if (productNodes.length > 0) {
            return {
              nodes: productNodes,
              usedFallback,
              ambiguity: { total: nodes.length, kept: productNodes.length },
            }
          }
          return { nodes, usedFallback, ambiguity: { total: nodes.length, kept: nodes.length } }
        }
        return { nodes, usedFallback }
      }

      const normalizedFocusDirs = normalizeFocusDirs(rawFocusDirs, meta?.indexedRoot)
      const pathByID =
        ctx?.pathByID ?? new Map((yield* port.listFiles()).map((file) => [file.id, file.path.replace(/\\/g, "/")]))
      const focused = nodes.filter((node) => pathMatchesFocusDirs(pathByID.get(node.fileID) ?? "", normalizedFocusDirs))
      if (focused.length > 0) {
        return {
          nodes: focused,
          usedFallback,
          ...(focused.length > 1 ? { ambiguity: { total: nodes.length, kept: focused.length } } : {}),
        }
      }
      return { nodes: [], usedFallback, ambiguity: { total: nodes.length, kept: 0 } }
    })

  const findTests = (
    input: { symbol: string; symbolID?: string },
    ctx?: QueryContext,
  ): Effect.Effect<TestsResult> =>
    Effect.gen(function* () {
      const allFiles = ctx?.allFiles ?? (yield* port.listFiles())
      const allNodesLight =
        ctx?.allNodesLight ?? (port.listNodes ? yield* port.listNodes({ limit: 100_000 }) : [])
      const testFilePatterns = [".test.ts", ".spec.ts", "test_", "_test.go", "_test.py", ".test.tsx", ".spec.tsx"]
      const testFileIDs = new Set(
        allFiles
          .filter((file) => testFilePatterns.some((pattern) => file.path.toLowerCase().includes(pattern)))
          .map((file) => file.id),
      )
      const testNodeIDs = new Set(allNodesLight.filter((node) => node.kind === "test").map((node) => node.id))
      const candidateIDs = allNodesLight
        .filter((node) => testNodeIDs.has(node.id) || testFileIDs.has(node.fileID))
        .map((node) => node.id)
      const candidateTestNodes = candidateIDs.length > 0 ? yield* port.nodesByIDs(candidateIDs) : []

      const doImportMatch = (symbolModule: string, symbolName: string): GraphNode[] => {
        const moduleBase = symbolModule.replace(/\.ts$/, "")
        return candidateTestNodes.filter(
          (node) => node.code?.includes(moduleBase) === true || node.code?.includes(symbolName) === true,
        )
      }

      const evidenceMatch = (
        symbolID: string,
      ): Effect.Effect<{ tests: GraphNode[]; derivation: TestDerivation }> =>
        Effect.gen(function* () {
          if (candidateTestNodes.length === 0) return { tests: [], derivation: "none" }
          const ids = candidateTestNodes.map((node) => node.id)
          const incoming = yield* port.edgesTo(ids)
          const testedBy: GraphNode[] = []
          for (const edge of incoming) {
            if (edge.kind !== "tested_by" || edge.fromNodeID !== symbolID) continue
            const node = candidateTestNodes.find((candidate) => candidate.id === edge.toNodeID)
            if (node) testedBy.push(node)
          }
          if (testedBy.length > 0) return { tests: testedBy, derivation: "tested_by" }

          const outgoing = yield* port.edgesFrom(ids)
          const hitIDs = new Set<string>()
          for (const edge of outgoing) {
            if (edge.kind !== "calls" && edge.kind !== "references") continue
            if (edge.toNodeID === symbolID) hitIDs.add(edge.fromNodeID)
          }
          const references = candidateTestNodes.filter((node) => hitIDs.has(node.id))
          if (references.length > 0) return { tests: references, derivation: "references" }
          return { tests: [], derivation: "none" }
        })

      const symbolID = yield* Effect.gen(function* () {
        if (input.symbolID) return input.symbolID
        const symbolResult = yield* findSymbol({ name: input.symbol }, ctx)
        if (symbolResult.nodes.length === 0) return undefined
        const searchName = input.symbol.includes(".") ? input.symbol.split(".").pop()! : input.symbol
        const exact = symbolResult.nodes.find((node) => node.name === searchName)
        return (exact ?? symbolResult.nodes[0])!.id
      })
      if (!symbolID) return { tests: [], notFound: true, derivation: "none" }

      const targetNode = yield* port.nodeByID(symbolID)
      if (!targetNode) return { tests: [], notFound: true, derivation: "none" }

      const targetFile = yield* port.fileByID(targetNode.fileID)
      if (!targetFile) return { tests: [], notFound: true, derivation: "none" }

      const evidence = yield* evidenceMatch(symbolID)
      if (evidence.tests.length > 0) return { tests: evidence.tests, notFound: false, derivation: evidence.derivation }
      const importMatches = doImportMatch(targetFile.path, input.symbol)
      if (importMatches.length > 0) return { tests: importMatches, notFound: false, derivation: "import" }
      return { tests: [], notFound: false, derivation: "none" }
    })

  const findRelated = (input: { nodeID: string; depth?: number }): Effect.Effect<GraphNode[]> =>
    Effect.gen(function* () {
      const run = yield* bfs(port, {
        start: [input.nodeID],
        direction: "both",
        edgeKinds: DEPENDENCY_EDGE_KINDS,
        outgoingEdgeKinds: DEPENDENCY_EDGE_KINDS,
        incomingEdgeKinds: CALLER_EDGE_KINDS,
        maxDepth: input.depth ?? 2,
      })
      return run.results.map((result) => result.node)
    })

  const findRelatedWithDepth = (
    input: { nodeID: string; depth?: number },
  ): Effect.Effect<Array<{ node: GraphNode; depth: number }>> =>
    Effect.gen(function* () {
      const run = yield* bfs(port, {
        start: [input.nodeID],
        direction: "both",
        edgeKinds: DEPENDENCY_EDGE_KINDS,
        outgoingEdgeKinds: DEPENDENCY_EDGE_KINDS,
        incomingEdgeKinds: CALLER_EDGE_KINDS,
        maxDepth: input.depth ?? 2,
      })
      return run.results.map((result) => ({ node: result.node, depth: result.depth }))
    })

  const findCallers = (input: { nodeID: string; depth?: number }): Effect.Effect<GraphNode[]> =>
    Effect.gen(function* () {
      const run = yield* bfs(port, {
        start: [input.nodeID],
        direction: "incoming",
        edgeKinds: CALLER_EDGE_KINDS,
        maxDepth: input.depth ?? 2,
      })
      return run.results.map((result) => result.node)
    })

  const findDependencies = (input: { nodeID: string; depth?: number }): Effect.Effect<GraphNode[]> =>
    Effect.gen(function* () {
      const run = yield* bfs(port, {
        start: [input.nodeID],
        direction: "outgoing",
        edgeKinds: DEPENDENCY_EDGE_KINDS,
        maxDepth: input.depth ?? 2,
      })
      return run.results.map((result) => result.node)
    })

  const loadQueryContext = (): Effect.Effect<QueryContext> =>
    Effect.gen(function* () {
      const [allFiles, allNodesLight, meta] = yield* Effect.all([
        port.listFiles(),
        port.listNodes ? port.listNodes({ limit: 100_000 }) : port.searchByName({ name: "", limit: 100_000 }),
        port.meta(),
      ])
      return {
        allFiles,
        allNodesLight,
        meta,
        pathByID: new Map(allFiles.map((file) => [file.id, file.path.replace(/\\/g, "/")])),
      }
    })

  const queryWithContext = (input: QueryInput, ctx: QueryContext): Effect.Effect<RepositoryContext> =>
    Effect.gen(function* () {
      const { allFiles, allNodesLight, meta, pathByID } = ctx
      const indexedRoot = meta?.indexedRoot as string | undefined

      const fileByPath = yield* resolveFileByPath(port, input.query, indexedRoot, allFiles)
      const symbolResult = yield* findSymbol({ name: input.query, workspace: input.workspace }, ctx)
      const fileMatches = fileByPath ? allNodesLight.filter((node) => node.fileID === fileByPath.id) : []

      const rawHits = port.searchFullText
        ? yield* port.searchFullText({ query: input.query, limit: input.limit ?? 50 }).pipe(Effect.orElseSucceed(() => []))
        : []
      const ftsHits = applyFocusDirsFilter(rawHits, input.workspace, indexedRoot, pathByID)
      const ftsDerivation = ftsHits.length > 0 ? "fts-bm25" : undefined

      const seen = new Set<string>()
      const symbols: GraphNode[] = []
      for (const hit of ftsHits) {
        if (seen.has(hit.id)) continue
        seen.add(hit.id)
        symbols.push(hit)
      }
      const symbolContribution = symbolResult.nodes.filter((node) => node.kind !== "doc")
      for (const node of [...symbolContribution, ...fileMatches]) {
        if (seen.has(node.id)) continue
        seen.add(node.id)
        symbols.push(node)
      }

      const testsResult =
        symbols.length > 0
          ? yield* findTests({ symbol: input.query }, ctx)
          : { tests: [] as GraphNode[], notFound: true, derivation: "none" as TestDerivation }

      const relatedNodes: GraphNode[] = []
      for (const symbol of symbols) {
        for (const related of yield* findRelated({ nodeID: symbol.id, depth: 1 })) {
          if (seen.has(related.id)) continue
          seen.add(related.id)
          relatedNodes.push(related)
        }
      }

      const graphNodeIDs = new Set<string>([...seen])
      const graphEdges: GraphEdge[] = []
      const allIDs = [...new Set([...symbols, ...relatedNodes].map((node) => node.id))]
      const outgoing = yield* port.edgesFrom(allIDs)
      const incoming = yield* port.edgesTo(allIDs)
      const outgoingBy = new Map<string, GraphEdge[]>()
      const incomingBy = new Map<string, GraphEdge[]>()
      for (const edge of outgoing) {
        const list = outgoingBy.get(edge.fromNodeID)
        if (list) list.push(edge)
        else outgoingBy.set(edge.fromNodeID, [edge])
      }
      for (const edge of incoming) {
        const list = incomingBy.get(edge.toNodeID)
        if (list) list.push(edge)
        else incomingBy.set(edge.toNodeID, [edge])
      }
      for (const id of allIDs) {
        for (const edge of outgoingBy.get(id) ?? []) {
          graphEdges.push(edge)
          graphNodeIDs.add(edge.toNodeID)
        }
        for (const edge of incomingBy.get(id) ?? []) {
          graphEdges.push(edge)
          graphNodeIDs.add(edge.fromNodeID)
        }
      }
      const graphNodes = graphNodeIDs.size > 0 ? yield* port.nodesByIDs([...graphNodeIDs]) : []

      const isOutsideFocusDirs =
        symbols.length === 0 &&
        symbolResult.ambiguity !== undefined &&
        symbolResult.ambiguity.kept === 0 &&
        (input.workspace?.focusDirs?.length ?? 0) > 0
      const isDegraded = symbols.length === 0 && !isOutsideFocusDirs
      const diagnostics: Diagnostic[] = []
      if (isOutsideFocusDirs) {
        diagnostics.push({
          kind: "outside-focus-dirs",
          message: `No candidate for "${input.query}" is inside the requested focusDirs (${(input.workspace?.focusDirs ?? []).join(", ")}). Loosen focusDirs or pass none.`,
        })
      } else if (isDegraded) {
        diagnostics.push({
          kind: "symbol-not-found",
          message: `No symbol matched "${input.query}". The graph may be stale — run /codegraph-build --force.`,
        })
      } else if (symbolResult.ambiguity) {
        diagnostics.push({
          kind: "ambiguous-symbol",
          message: "Multiple exact-name matches found; pass focusDirs to disambiguate.",
        })
      } else if (ftsDerivation) {
        diagnostics.push({
          kind: "fts-fallback",
          message: `Resolved via FTS5 bm25 ranking for "${input.query}".`,
        })
      }

      const bucketFileIDs = new Set(
        [...symbols, ...relatedNodes].map((node) => node.fileID).filter((id): id is string => Boolean(id)),
      )

      const docs = isDegraded ? [] : allFiles.filter((file) => bucketFileIDs.has(file.id) && isDocPath(file.path))
      const configs = isDegraded ? [] : allFiles.filter((file) => bucketFileIDs.has(file.id) && isConfigPath(file.path))
      const files = isDegraded ? [] : allFiles.filter((file) => bucketFileIDs.has(file.id))

      const recentCommits = yield* git.recentCommits({
        limit: input.limit ?? 10,
        ...(input.workspace?.worktree ? { cwd: input.workspace.worktree } : {}),
      })

      const status: RepositoryContext["status"] = isDegraded ? "failed" : "success"
      const reason = isDegraded
        ? `No matching symbols found for query "${input.query}"`
        : isOutsideFocusDirs
          ? `No candidate for "${input.query}" is inside the requested focusDirs.`
          : undefined
      const recoveryHint = isDegraded
        ? `Run /codegraph-build --force to refresh the index, or use code_find with intent='definition' to search broadly.`
        : isOutsideFocusDirs
          ? `Loosen focusDirs or pass none to search the whole graph.`
          : undefined

      const queryLower = input.query.toLowerCase()
      const normalizedFocusDirs =
        (input.workspace?.focusDirs.length ?? 0) > 0
          ? normalizeFocusDirs(input.workspace!.focusDirs, indexedRoot)
          : []
      const ftsOrder = new Map<string, number>()
      ftsHits.forEach((hit, index) => {
        if (!ftsOrder.has(hit.id)) ftsOrder.set(hit.id, index)
      })
      const ranking = rankCandidates(
        symbols.map((node) => ({
          node,
          query: input.query,
          exact: node.name.toLowerCase() === queryLower,
          bm25Score: ftsOrder.has(node.id) ? Math.max(0, 1 - ftsOrder.get(node.id)! / Math.max(ftsHits.length, 1)) : 0,
          workspaceProximity:
            normalizedFocusDirs.length > 0 && pathMatchesFocusDirs(pathByID.get(node.fileID) ?? "", normalizedFocusDirs)
              ? 1
              : 0,
        })),
      )

      return {
        status,
        reason,
        recoveryHint,
        degraded: isDegraded,
        fallbackUsed: symbolResult.usedFallback,
        query: input.query,
        ...(ftsDerivation ? { searchDerivation: ftsDerivation } : {}),
        symbols,
        files,
        graph: { nodes: graphNodes, edges: graphEdges },
        tests: testsResult.tests.filter((node) => bucketFileIDs.has(node.fileID)),
        docs,
        configs,
        git: { recentCommits: [...recentCommits], ownership: [] },
        workspace: input.workspace,
        diagnostics,
        ranking: { ...ranking, workspace: input.workspace },
        ...(symbolResult.ambiguity ? { ambiguity: symbolResult.ambiguity } : {}),
      }
    })

  const query = (input: QueryInput): Effect.Effect<RepositoryContext> =>
    Effect.gen(function* () {
      const ctx = yield* loadQueryContext()
      return yield* queryWithContext(input, ctx)
    })

  const slice = (ctx: RepositoryContext): Effect.Effect<ArchitecturalSlice> =>
    Effect.gen(function* () {
      const entrypoints = ctx.symbols.filter(
        (node) => node.kind === "function" || node.kind === "class" || node.kind === "route" || node.kind === "method",
      )
      const importantSymbols = ctx.symbols.filter(
        (node) => node.kind !== "variable" && node.kind !== "type" && node.kind !== "file" && node.kind !== "generated",
      )
      const routes = ctx.symbols.filter((node) => node.kind === "route")
      const summaryParts = [`Query "${ctx.query}"`]
      if (ctx.symbols.length > 0) summaryParts.push(`${ctx.symbols.length} symbols`)
      if (ctx.tests.length > 0) summaryParts.push(`${ctx.tests.length} tests`)
      if (ctx.docs.length > 0) summaryParts.push(`${ctx.docs.length} docs`)
      if (ctx.configs.length > 0) summaryParts.push(`${ctx.configs.length} configs`)
      if (ctx.graph.edges.length > 0) summaryParts.push(`${ctx.graph.edges.length} edges`)

      const defaultLimit = 25
      const directCallersSet = new Map<string, GraphNode>()
      const transitiveSet = new Map<string, GraphNode>()
      const dependencySet = new Map<string, { name: string; version?: string }>()

      // Prefer a production symbol as the anchor: FTS can surface a test or a
      // doc node first for a qualified query, and anchoring there reports zero
      // callers for a symbol that demonstrably has them.
      const anchor = ctx.symbols.find((node) => node.kind !== "test" && node.kind !== "doc" && node.kind !== "file")
      if (anchor) {
        const anchorID = anchor.id
        for (const caller of yield* findCallers({ nodeID: anchorID, depth: 1 })) directCallersSet.set(caller.id, caller)
        for (const node of yield* findCallers({ nodeID: anchorID, depth: 3 })) {
          if (!directCallersSet.has(node.id)) transitiveSet.set(node.id, node)
        }
        for (const node of yield* findDependencies({ nodeID: anchorID, depth: 1 })) {
          if (node.kind === "function" || node.kind === "class" || node.kind === "method" || node.kind === "type") {
            dependencySet.set(node.name, { name: node.name })
          }
        }
      }

      const filterFileIDs = new Set<string>()
      for (const node of directCallersSet.values()) filterFileIDs.add(node.fileID)
      for (const node of transitiveSet.values()) filterFileIDs.add(node.fileID)
      const filterFiles = yield* port.listFiles()
      const pathByID = new Map(filterFiles.map((file) => [file.id, file.path]))
      const isSource = (node: GraphNode): boolean => {
        const path = pathByID.get(node.fileID)
        return path ? !isTestFilePath(path) : true
      }
      for (const [id, node] of [...directCallersSet.entries()]) if (!isSource(node)) directCallersSet.delete(id)
      for (const [id, node] of [...transitiveSet.entries()]) if (!isSource(node)) transitiveSet.delete(id)

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
        summary: summaryParts.join(" — "),
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
      }
    })

  const explain = (input: ExplainInput): Effect.Effect<ArchitecturalSlice> =>
    query({ query: input.symbol, workspace: input.workspace }).pipe(Effect.flatMap(slice))

  const impact = (input: ImpactInput): Effect.Effect<ArchitecturalSlice> =>
    Effect.gen(function* () {
      const ctx = yield* loadQueryContext()
      const file = yield* resolveFileByPath(port, input.path, ctx.meta?.indexedRoot as string | undefined, ctx.allFiles)
      if (!file) {
        const repository = yield* queryWithContext({ query: input.path, workspace: input.workspace }, ctx)
        return yield* slice(repository)
      }

      const fileNodes = yield* port.nodesByFile(file.id)
      const resultLimit = 25
      const [dependentsRun, dependenciesRun] = yield* Effect.all([
        bfs(port, {
          start: fileNodes.map((node) => node.id),
          direction: "incoming",
          edgeKinds: CALLER_EDGE_KINDS,
          maxDepth: 3,
          resultLimit,
        }),
        bfs(port, {
          start: fileNodes.map((node) => node.id),
          direction: "outgoing",
          edgeKinds: DEPENDENCY_EDGE_KINDS,
          maxDepth: 3,
          resultLimit,
        }),
      ])
      const repository = yield* queryWithContext({ query: input.path, workspace: input.workspace }, ctx)
      const base = yield* slice(repository)

      const importantSymbols = new Map<string, GraphNode>()
      const isImportant = (node: GraphNode) =>
        node.kind !== "variable" && node.kind !== "type" && node.kind !== "file" && node.kind !== "generated"
      for (const node of fileNodes) if (isImportant(node)) importantSymbols.set(node.id, node)
      for (const result of dependentsRun.results) if (isImportant(result.node)) importantSymbols.set(result.node.id, result.node)

      const dependencies = new Map<string, { name: string; version?: string }>()
      for (const result of dependenciesRun.results) {
        if (
          result.node.kind === "function" ||
          result.node.kind === "class" ||
          result.node.kind === "method" ||
          result.node.kind === "type"
        ) {
          dependencies.set(result.node.name, { name: result.node.name })
        }
      }

      return {
        ...base,
        importantSymbols: [...importantSymbols.values()],
        dependencies: [...dependencies.values()],
        directCallers: dependentsRun.results.filter((result) => result.depth === 1).map((result) => result.node),
        transitiveDependents: dependentsRun.results.filter((result) => result.depth > 1).map((result) => result.node),
      }
    })

  const trace = (input: TraceInput): Effect.Effect<ArchitecturalSlice> =>
    Effect.gen(function* () {
      const repository = yield* query({ query: input.symbol, workspace: input.workspace })
      const base = yield* slice(repository)

      if (repository.symbols.length === 0) {
        return { ...base, directCallers: [], transitiveDependents: [] }
      }

      const anchor =
        repository.symbols.find((node) => node.kind !== "test" && node.kind !== "doc" && node.kind !== "file") ??
        repository.symbols[0]!
      const maxDepth = input.depth ?? 2
      const limit = Math.max(1, Math.min(1000, input.limit ?? 50))

      const tagged = yield* findRelatedWithDepth({ nodeID: anchor.id, depth: maxDepth })
      const isCodeLike = (node: GraphNode) =>
        node.kind === "function" || node.kind === "class" || node.kind === "method"
      const bfsCallers: GraphNode[] = []
      const transitiveTagged: Array<{ node: GraphNode; depth: number }> = []
      for (const entry of tagged) {
        if (!isCodeLike(entry.node)) continue
        if (entry.depth === 1) bfsCallers.push(entry.node)
        else transitiveTagged.push({ node: entry.node, depth: entry.depth })
      }

      const fileIDs = new Set(transitiveTagged.map((entry) => entry.node.fileID))
      const files = yield* port.listFiles()
      const filePathByID = new Map(files.filter((file) => fileIDs.has(file.id)).map((file) => [file.id, file.path]))

      const ranked = rankTransitiveDependents(transitiveTagged, filePathByID)
      const visible = ranked.length > limit ? ranked.slice(0, limit) : ranked
      const moreDependents = ranked.length > limit ? ranked.length - limit : 0

      const directCallers = base.directCallers.length > 0 ? [...base.directCallers] : bfsCallers

      const diagnostics: Array<{ kind: string; message: string }> = []
      if (directCallers.length === 0 && visible.length === 0) {
        const testOnly = bfsCallers.length > 0 && directCallers.length === 0
        diagnostics.push(
          testOnly
            ? {
                kind: "no-source-callers",
                message: "only test-file callers reference this symbol; no production callers were found",
              }
            : {
                kind: "no-edges-found",
                message: "no callers or dependents reference this symbol in the current graph",
              },
        )
      }

      return {
        ...base,
        directCallers,
        transitiveDependents: visible,
        entrypoints: directCallers,
        moreAvailable: moreDependents > 0 ? { dependents: moreDependents } : undefined,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      }
    })

  const tests = (input: { symbol: string; limit?: number }): Effect.Effect<TestsResult> =>
    Effect.gen(function* () {
      const result = yield* findTests(input)
      const limit = Math.max(1, Math.min(500, input.limit ?? 50))
      return { ...result, tests: result.tests.slice(0, limit) }
    })

  const symbols = (input: { query: string; limit?: number }): Effect.Effect<readonly GraphNode[]> =>
    Effect.gen(function* () {
      const result = yield* findSymbol({ name: input.query })
      return result.nodes.slice(0, Math.max(1, Math.min(500, input.limit ?? 50)))
    })

  const relationships = (input: { nodeID?: string; path?: string; depth?: number }): Effect.Effect<readonly GraphNode[]> => {
    if (input.path && !input.nodeID) {
      const inputPath = input.path
      return Effect.gen(function* () {
        const meta = yield* port.meta()
        const file = yield* resolveFileByPath(port, inputPath, meta?.indexedRoot)
        if (!file) return []
        const fileNodes = yield* port.nodesByFile(file.id)
        const seen = new Set<string>()
        const result: GraphNode[] = []
        for (const anchor of fileNodes) {
          for (const node of yield* findRelated({ nodeID: anchor.id, depth: input.depth ?? 1 })) {
            if (seen.has(node.id)) continue
            seen.add(node.id)
            result.push(node)
          }
        }
        return result
      })
    }
    if (!input.nodeID) return Effect.succeed([])
    return findRelated({ nodeID: input.nodeID, depth: input.depth })
  }

  const findOwner = (input: { path: string; cwd?: string }) => git.owners(input)

  return {
    query,
    slice,
    explain,
    impact,
    trace,
    tests,
    symbols,
    relationships,
    findOwner,
    meta: () => port.meta(),
  }
}

const applyFocusDirsFilter = (
  hits: readonly GraphNode[],
  workspace: WorkspaceContext | undefined,
  indexedRoot: string | undefined,
  pathByID: ReadonlyMap<string, string>,
): GraphNode[] => {
  const rawFocusDirs = workspace?.focusDirs ?? []
  const normalizedFocusDirs = rawFocusDirs.length > 0 ? normalizeFocusDirs(rawFocusDirs, indexedRoot) : rawFocusDirs
  const filtered = hits.filter((hit) => {
    if (rawFocusDirs.length === 0) return true
    return pathMatchesFocusDirs(pathByID.get(hit.fileID) ?? "", normalizedFocusDirs)
  })
  if (rawFocusDirs.length === 0 && filtered.length > 1) {
    const productHits = filtered.filter((hit) => {
      const path = pathByID.get(hit.fileID) ?? ""
      return PRODUCT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
    })
    if (productHits.length > 0) return productHits
  }
  return filtered
}
