import { Effect, Layer } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import { resolveGraphTargetPure } from "../symbol-resolver"
import { bfsPure } from "./bfs"
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
const RELATED_EDGE_KINDS: ReadonlySet<CodegraphEdge["kind"]> = new Set([
  "calls",
  "references",
  "imports",
  "extends",
])

function isDocPath(path: string): boolean {
  return DOC_PATH_PATTERNS.some((p) => p.test(path))
}

// Reduce focusDirs to graph-relative, slash-normalized paths so callers can
// compare them against `codegraph_files.path` directly. When `indexedRoot`
// is provided, prefixes that match it are stripped to avoid double-prefixing
// (e.g. `C:/repo/packages/opencode` → `packages/opencode`).
const normalizeFocusDirs = (focusDirs: readonly string[], indexedRoot?: string): readonly string[] => {
  if (focusDirs.length === 0) return focusDirs
  const root = indexedRoot ? indexedRoot.replace(/\\/g, "/").replace(/\/+$/, "") : undefined
  return focusDirs.map((d) => {
    const cleaned = d.replace(/\\/g, "/").trim()
    if (!cleaned) return cleaned
    if (root && cleaned === root) return ""
    if (root && cleaned.startsWith(root + "/")) return cleaned.slice(root.length + 1)
    return cleaned
  })
}

const pathMatchesFocusDirs = (normalizedPath: string, normalizedFocusDirs: readonly string[]): boolean => {
  if (normalizedFocusDirs.length === 0) return true
  return normalizedFocusDirs.some((prefix) => {
    if (!prefix) return true
    return normalizedPath === prefix || normalizedPath.startsWith(prefix + "/")
  })
}

// Normalize a caller-provided path against the indexed graph's root so
// the same input resolves whether the user typed an absolute Windows
// path, a path with backslashes, or a clean repo-relative path. The
// graph stores paths relative to `codegraph_meta.indexed_root`, so any
// incoming path must be reduced to the same form before being looked
// up via `getFileByPath`.
const normalizePathForLookup = (input: string, indexedRoot?: string): string => {
  const cleaned = input.replace(/\\/g, "/").trim()
  if (!cleaned) return cleaned
  if (!indexedRoot) return cleaned
  const root = indexedRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  if (cleaned === root) return ""
  if (cleaned.startsWith(root + "/")) {
    return cleaned.slice(root.length + 1)
  }
  return cleaned
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
          const meta = yield* repo.getMeta()
          const normalizedInput = normalizePathForLookup(input.file, meta?.indexedRoot)
          const file = yield* repo.getFileByPath(normalizedInput)
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
        const rawFocusDirs = input.workspace?.focusDirs ?? []
        const hasFocusDirs = rawFocusDirs.length > 0

        if (input.exact) {
          nodes = nodes.filter((n) => n.name === input.name)
        }

        // Resolve graph-relative focusDirs once. Pull indexedRoot from the
        // graph metadata so a caller-supplied worktree path can never
        // double-prefix the comparison.
        const meta = hasFocusDirs ? yield* repo.getMeta() : undefined
        const normalizedFocusDirs = hasFocusDirs
          ? normalizeFocusDirs(rawFocusDirs, meta?.indexedRoot)
          : rawFocusDirs

        if (hasFocusDirs) {
          // Batch-fetch every candidate file in one query instead of N.
          // The previous implementation issued a `getFile` per candidate,
          // turning resolution into O(N) round-trips on cold DBs.
          const candidateFileIDs = Array.from(new Set(nodes.map((n) => n.fileID)))
          const files = yield* repo.filesByIDs(candidateFileIDs)
          const filePathByID = new Map<string, string>()
          for (const f of files) filePathByID.set(f.id, f.path.replace(/\\/g, "/"))

          const focused: CodegraphNode[] = []
          for (const node of nodes) {
            const path = filePathByID.get(node.fileID) ?? ""
            if (pathMatchesFocusDirs(path, normalizedFocusDirs)) focused.push(node)
          }

          if (focused.length > 0) {
            return {
              nodes: focused,
              usedFallback: derivation === "tag-fallback",
              ...(focused.length > 1
                ? { ambiguity: { total: nodes.length, kept: focused.length } }
                : {}),
            }
          }

          // Plan: do not silently fall back when focusDirs was specified
          // and no candidate matches. Surface an explicit
          // `outside-focus-dirs` diagnostic from the caller rather than
          // smuggling an out-of-scope node into the result.
          return {
            nodes: [],
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

          // Batch file lookup for the product-package tie-breaker so the
          // unscoped path stops issuing one query per node too.
          const candidateFileIDs = Array.from(new Set(nodes.map((n) => n.fileID)))
          const files = yield* repo.filesByIDs(candidateFileIDs)
          const filePathByNodeID = new Map<string, string>()
          for (const f of files) {
            for (const node of nodes) {
              if (node.fileID === f.id) filePathByNodeID.set(node.id, f.path.replace(/\\/g, "/"))
            }
          }

          const productNodes = nodes.filter((n) => {
            const path = filePathByNodeID.get(n.id) ?? ""
            return PRODUCT_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))
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
        const edgeKinds = new Set<CodegraphEdge["kind"]>([
          "calls",
          "references",
          "extends",
          "imports",
        ])
        const run = yield* bfsPure(repo, {
          start: [nodeID],
          direction: "both",
          edgeKinds,
          maxDepth,
        })
        return run.results.map((r) => r.node)
      })

    const findTests = (input: {
      symbol: string
      symbolID?: string
    }): Effect.Effect<
      { tests: readonly CodegraphNode[]; notFound: boolean; derivation: "tested_by" | "references" | "import" | "substring" | "none" },
      never,
      never
    > =>
      Effect.gen(function* () {
        // Phase 4: rank test matches by evidence. tested_by edges are
        // exact; references/calls edges are strong; import + substring
        // matches are explicitly low-confidence and only surface when no
        // graph edge connects the test to the target.
        // Discover test files by either `kind = "test"` OR a `.test/.spec`
        // path pattern so we cover fixtures that omit the kind field.
        const testFilePatterns = [".test.ts", ".spec.ts", "test_", "_test.go", "_test.py", ".test.tsx", ".spec.tsx"]
        const allFiles = yield* repo.listAllFiles()
        const testFileIDs = new Set(
          allFiles
            .filter((f) => testFilePatterns.some((p) => f.path.toLowerCase().includes(p.toLowerCase())))
            .map((f) => f.id),
        )
        const allNodes = yield* repo.listAllNodes()
        const testNodesFromKind = yield* repo.listNodesByKind("test")
        const testNodeIDs = new Set(testNodesFromKind.map((n) => n.id))
        const candidateTestNodes = allNodes.filter(
          (n) => testNodeIDs.has(n.id) || testFileIDs.has(n.fileID),
        )

        const doImportMatch = (symbolModule: string, symbolName: string): CodegraphNode[] => {
          const moduleBase = symbolModule.replace(/\.ts$/, "")
          const matching: CodegraphNode[] = []
          for (const testNode of candidateTestNodes) {
            if (!testNode.code) continue
            if (testNode.code.includes(moduleBase) || testNode.code.includes(symbolName)) {
              matching.push(testNode)
            }
          }
          return matching
        }

        const doEvidenceMatch = (
          symbolID: string,
        ): Effect.Effect<{ tests: CodegraphNode[]; derivation: "tested_by" | "references" | "none" }, never, never> =>
          Effect.gen(function* () {
            if (candidateTestNodes.length === 0) return { tests: [], derivation: "none" }

            const candidateIDs = candidateTestNodes.map((t) => t.id)

            // 1) tested_by edges pointing AT a test node FROM the symbol —
            // strongest evidence. One batched query for all candidates'
            // incoming edges.
            const incomingToCandidates = yield* repo.edgesToBatch(candidateIDs)
            const testedBy: CodegraphNode[] = []
            for (const edge of incomingToCandidates) {
              if (edge.kind !== "tested_by") continue
              if (edge.fromNodeID !== symbolID) continue
              const testNode = candidateTestNodes.find((t) => t.id === edge.toNodeID)
              if (testNode) testedBy.push(testNode)
            }
            if (testedBy.length > 0) return { tests: testedBy, derivation: "tested_by" }

            // 2) calls/references edges FROM each test node TO the symbol —
            // strong evidence, batched per the same frontier model.
            const outgoingFromCandidates = yield* repo.edgesFromBatch(candidateIDs)
            const edgeByCandidate = new Map<string, CodegraphEdge[]>()
            for (const edge of outgoingFromCandidates) {
              if (edge.kind !== "calls" && edge.kind !== "references") continue
              if (edge.toNodeID !== symbolID) continue
              const list = edgeByCandidate.get(edge.fromNodeID) ?? []
              list.push(edge)
              edgeByCandidate.set(edge.fromNodeID, list)
            }
            const references: CodegraphNode[] = []
            for (const testNode of candidateTestNodes) {
              if ((edgeByCandidate.get(testNode.id) ?? []).length > 0) references.push(testNode)
            }
            if (references.length > 0) return { tests: references, derivation: "references" }

            return { tests: [], derivation: "none" }
          })

        if (input.symbolID) {
          const targetNode = yield* repo.nodeByID(input.symbolID)
          if (!targetNode) return { tests: [], notFound: true, derivation: "none" }
          const targetFile = yield* repo.getFile(targetNode.fileID)
          if (!targetFile) return { tests: [], notFound: true, derivation: "none" }

          const evidence = yield* doEvidenceMatch(input.symbolID)
          if (evidence.tests.length > 0) {
            return { tests: evidence.tests, notFound: false, derivation: evidence.derivation }
          }
          const importMatching = doImportMatch(targetFile.path, input.symbol)
          if (importMatching.length > 0) {
            return { tests: importMatching, notFound: false, derivation: "import" }
          }
          return { tests: [], notFound: false, derivation: "none" }
        }

        const symbolResult = yield* findSymbol({ name: input.symbol })
        if (symbolResult.nodes.length === 0) {
          return { tests: [], notFound: true, derivation: "none" }
        }

        const searchName = input.symbol.includes(".") ? input.symbol.split(".").pop()! : input.symbol
        const exactMatch = symbolResult.nodes.find((n) => n.name === searchName)
        const symbolID = (exactMatch ?? symbolResult.nodes[0])!.id

        const targetNode = yield* repo.nodeByID(symbolID)
        if (!targetNode) return { tests: [], notFound: true, derivation: "none" }
        const targetFile = yield* repo.getFile(targetNode.fileID)
        if (!targetFile) return { tests: [], notFound: true, derivation: "none" }

        const evidence = yield* doEvidenceMatch(symbolID)
        if (evidence.tests.length > 0) {
          return { tests: evidence.tests, notFound: false, derivation: evidence.derivation }
        }
        const importMatching = doImportMatch(targetFile.path, input.symbol)
        if (importMatching.length > 0) {
          return { tests: importMatching, notFound: false, derivation: "import" }
        }
        return { tests: [], notFound: false, derivation: "none" }
      })

    const findRelated = (input: {
      nodeID: string
      depth?: number
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const run = yield* bfsPure(repo, {
          start: [input.nodeID],
          direction: "both",
          edgeKinds: RELATED_EDGE_KINDS,
          outgoingEdgeKinds: DEPENDENCY_EDGE_KINDS,
          incomingEdgeKinds: CALLER_EDGE_KINDS,
          maxDepth: input.depth ?? 2,
        })
        return run.results.map((r) => r.node)
      })

    // Depth-tagged BFS. Each discovered node carries the per-node hop distance
    // from the anchor (depth=1 means the anchor calls/touches it directly).
    // Directional-but-tolerant: outgoing uses all dependency kinds, incoming
    // uses only caller kinds (calls/references).
    const findRelatedWithDepth = (input: {
      nodeID: string
      depth?: number
    }): Effect.Effect<Array<{ readonly node: CodegraphNode; readonly depth: number }>, never, never> =>
      Effect.gen(function* () {
        const run = yield* bfsPure(repo, {
          start: [input.nodeID],
          direction: "both",
          edgeKinds: RELATED_EDGE_KINDS,
          outgoingEdgeKinds: DEPENDENCY_EDGE_KINDS,
          incomingEdgeKinds: CALLER_EDGE_KINDS,
          maxDepth: input.depth ?? 2,
        })
        return run.results.map((r) => ({ node: r.node, depth: r.depth }))
      })

    // Strict directional BFS: incoming calls/references only.
    const findCallers = (input: {
      nodeID: string
      depth?: number
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const run = yield* bfsPure(repo, {
          start: [input.nodeID],
          direction: "incoming",
          edgeKinds: CALLER_EDGE_KINDS,
          maxDepth: input.depth ?? 2,
        })
        return run.results.map((r) => r.node)
      })

    // Strict directional BFS: outgoing calls/references/imports/extends only.
    const findDependencies = (input: {
      nodeID: string
      depth?: number
    }): Effect.Effect<CodegraphNode[], never, never> =>
      Effect.gen(function* () {
        const run = yield* bfsPure(repo, {
          start: [input.nodeID],
          direction: "outgoing",
          edgeKinds: DEPENDENCY_EDGE_KINDS,
          maxDepth: input.depth ?? 2,
        })
        return run.results.map((r) => r.node)
      })

    const query = (input: {
      query: string
      limit?: number
      workspace?: WorkspaceContext
    }): Effect.Effect<RepositoryContext, never, never> =>
      Effect.gen(function* () {
        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()
        const meta = yield* repo.getMeta()
        const indexedRoot = meta?.indexedRoot

        const normalizedQuery = normalizePathForLookup(input.query, indexedRoot)
        const symbolResult = yield* findSymbol({ name: input.query, workspace: input.workspace })
        const fileByPath = yield* repo.getFileByPath(normalizedQuery)
        const fileMatches: CodegraphNode[] = fileByPath
          ? allNodes.filter((n) => n.fileID === fileByPath.id)
          : []

        const isMultiToken = /\s/.test(input.query)
        const ftsHits = isMultiToken && symbolResult.nodes.length === 0
          ? yield* repo.ftsSearchNodes({ query: input.query, limit: input.limit ?? 50 })
          : []
        const ftsDerivation = ftsHits.length > 0 ? ("fts-bm25" as const) : undefined

        const seen = new Set<string>()
        const symbols: CodegraphNode[] = []
        for (const hit of ftsHits) {
          if (!seen.has(hit.id)) {
            seen.add(hit.id)
            symbols.push(hit)
          }
        }
        for (const n of [...symbolResult.nodes, ...fileMatches]) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            symbols.push(n)
          }
        }

        const testsResult = symbols.length > 0 ? yield* findTests({ symbol: input.query }) : { tests: [] as readonly CodegraphNode[], notFound: true, derivation: "none" as const }

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
        const allIDs = [...new Set([...symbols, ...relatedNodes].map((node) => node.id))]
        const outgoingEdges = yield* repo.edgesFromBatch(allIDs)
        const incomingEdges = yield* repo.edgesToBatch(allIDs)
        const outgoingByNode = new Map<string, CodegraphEdge[]>()
        const incomingByNode = new Map<string, CodegraphEdge[]>()
        for (const edge of outgoingEdges) {
          const edges = outgoingByNode.get(edge.fromNodeID) ?? []
          edges.push(edge)
          outgoingByNode.set(edge.fromNodeID, edges)
        }
        for (const edge of incomingEdges) {
          const edges = incomingByNode.get(edge.toNodeID) ?? []
          edges.push(edge)
          incomingByNode.set(edge.toNodeID, edges)
        }
        for (const id of allIDs) {
          for (const edge of outgoingByNode.get(id) ?? []) {
            graphEdges.push(edge)
            graphNodeIDs.add(edge.toNodeID)
          }
          for (const edge of incomingByNode.get(id) ?? []) {
            graphEdges.push(edge)
            graphNodeIDs.add(edge.fromNodeID)
          }
        }
        const graphNodesList = graphNodeIDs.size > 0 ? yield* repo.nodesByIDs([...graphNodeIDs]) : []

        const isOutsideFocusDirs =
          symbols.length === 0 &&
          symbolResult.ambiguity !== undefined &&
          symbolResult.ambiguity.kept === 0 &&
          (input.workspace?.focusDirs?.length ?? 0) > 0
        const isDegraded = symbols.length === 0 && !isOutsideFocusDirs
        const diagnostics: { kind: string; message: string; candidates?: readonly CodegraphNode[] }[] = []
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
          const candidateFiles: CodegraphNode[] = []
          const candidateFileIDs = Array.from(new Set(symbolResult.nodes.map((n) => n.fileID)))
          if (candidateFileIDs.length > 0) {
            const files = yield* repo.filesByIDs(candidateFileIDs)
            const known = new Set(files.map((f) => f.id))
            for (const n of symbolResult.nodes) {
              if (known.has(n.fileID)) candidateFiles.push(n)
            }
          }
          diagnostics.push({
            kind: "ambiguous-symbol",
            message: "Multiple exact-name matches found; pass focusDirs to disambiguate.",
            candidates: candidateFiles,
          })
        } else if (ftsDerivation) {
          diagnostics.push({
            kind: "fts-fallback",
            message: `Resolved via FTS5 bm25 ranking for "${input.query}".`,
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
          graph: { nodes: graphNodesList, edges: graphEdges },
          tests: testsResult.tests.filter((n) => bucketFileIDs.has(n.fileID)),
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
        const meta = yield* repo.getMeta()
        const normalizedPath = normalizePathForLookup(input.path, meta?.indexedRoot)
        const file = yield* repo.getFileByPath(normalizedPath)
        if (!file) {
          const ctx = yield* query({ query: input.path, workspace: input.workspace })
          return yield* slice(ctx)
        }

        const fileNodes = yield* repo.listNodesByFile(file.id)
        const resultLimit = 25
        const [dependentsRun, dependenciesRun] = yield* Effect.all([
          bfsPure(repo, {
            start: fileNodes.map((node) => node.id),
            direction: "incoming",
            edgeKinds: CALLER_EDGE_KINDS,
            maxDepth: 3,
            resultLimit,
          }),
          bfsPure(repo, {
            start: fileNodes.map((node) => node.id),
            direction: "outgoing",
            edgeKinds: DEPENDENCY_EDGE_KINDS,
            maxDepth: 3,
            resultLimit,
          }),
        ])
        const ctx = yield* query({ query: input.path, workspace: input.workspace })
        const slc = yield* slice(ctx)
        const importantSymbols = new Map<string, CodegraphNode>()
        for (const node of fileNodes) {
          if (node.kind !== "variable" && node.kind !== "type" && node.kind !== "file" && node.kind !== "generated") {
            importantSymbols.set(node.id, node)
          }
        }
        for (const result of dependentsRun.results) {
          if (result.node.kind !== "variable" && result.node.kind !== "type" && result.node.kind !== "file" && result.node.kind !== "generated") {
            importantSymbols.set(result.node.id, result.node)
          }
        }
        const dependencies = new Map<string, { name: string; version?: string }>()
        for (const result of dependenciesRun.results) {
          if (result.node.kind === "function" || result.node.kind === "class" || result.node.kind === "method" || result.node.kind === "type") {
            dependencies.set(result.node.name, { name: result.node.name })
          }
        }

        return {
          ...slc,
          importantSymbols: [...importantSymbols.values()],
          dependencies: [...dependencies.values()],
          directCallers: dependentsRun.results.filter((result) => result.depth === 1).map((result) => result.node),
          transitiveDependents: dependentsRun.results.filter((result) => result.depth > 1).map((result) => result.node),
        } satisfies ArchitecturalSlice
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
        const files = yield* repo.filesByIDs([...fileIDs])
        for (const file of files) filePathByID.set(file.id, file.path)

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
        return { tests: result.tests, notFound: result.notFound }
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
          const meta = yield* repo.getMeta()
          const normalizedPath = normalizePathForLookup(input.path, meta?.indexedRoot)
          const file = yield* repo.getFileByPath(normalizedPath)
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
