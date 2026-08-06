import { Effect, Layer } from "effect"
import { CodegraphRepo } from "../codegraph-repo"
import type { Interface as CodegraphRepoInterface } from "../codegraph-repo"
import { resolveGraphTargetPure } from "../symbol-resolver"
import { isTestFilePath, resolveFileByPath, toRepoRelativePath } from "../codegraph-paths"
import { bfsPure } from "./bfs"
import { rank, type RankingResult } from "../ranking/rank"
import { Service } from "./service"
import type { Interface } from "./service"
import type {
  ArchitecturalSlice,
  CodegraphBinding,
  CodegraphEdge,
  CodegraphFile,
  CodegraphMeta,
  CodegraphNode,
  RepositoryContext,
  TestMatch,
  TestMatchDerivation,
  WorkspaceContext,
} from "../types"
import { Service as Git, defaultLayer as gitDefaultLayer } from "./git-service"

export type { Interface }
export { Service }

const DOC_PATH_PATTERNS = [/\.md$/i, /^readme/i, /^changelog/i, /^contributing/i, /\/docs?\//i, /^design/i]
const CONFIG_PATH_PATTERNS = [/package\.json$/i, /tsconfig.*\.json$/i, /pyproject\.toml$/i, /cargo\.toml$/i, /go\.mod$/i, /pnpm-workspace\.yaml$/i, /bun\.fig\.toml$/i]

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

// Shared per-call context for the query() pipeline: the files table +
// metadata-only (light) node projection + graph meta, loaded exactly once
// per invocation and threaded through query/findTests so the 2-4x
// listAllFiles/listAllNodes reloads collapse to a single load. Light nodes
// omit the `code` column (searchNodesLight); the only consumer that needs
// `code` (findTests' substring import matching) fetches it per-candidate
// via nodesByIDs.
type QueryContext = {
  readonly allFiles: readonly CodegraphFile[]
  readonly allNodesLight: ReadonlyArray<Omit<CodegraphNode, "code"> & { code?: never }>
  readonly meta: CodegraphMeta | undefined
}

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

const PRODUCT_PREFIXES = ["packages/opencode", "packages/core", "packages/tui"]

// Phase 3: post-filter FTS hits to mirror what `findSymbol` does
// internally. Two rules apply when the caller did NOT pass focusDirs:
//   1. focusDirs filter (when present) — the FTS hit's file must be
//      inside one of the requested dirs.
//   2. product-prefix tie-breaker — when the unscoped query has
//      multiple matches across packages, prefer the rows in the
//      product packages (opencode/core/tui) over rows in UI packages
//      (web/desktop/app). The pre-Phase-3 path only emitted product
//      matches; the new FTS hits would otherwise surface the UI ones
//      too, regressing the result. The tie-breaker fires when more
//      than one FTS hit survives rule (1) and at least one of them
//      is in a product package; UI rows are dropped to keep the
//      post-Phase-3 result aligned with the pre-Phase-3 one.
const applyFocusDirsFilter = (
  hits: readonly CodegraphNode[],
  workspace: WorkspaceContext | undefined,
  indexedRoot: string | undefined,
  allFiles: readonly CodegraphFile[],
): CodegraphNode[] => {
  const filePathByID = new Map<string, string>()
  for (const f of allFiles) filePathByID.set(f.id, toRepoRelativePath(f.path, indexedRoot))
  const rawFocusDirs = workspace?.focusDirs ?? []
  const normalizedFocusDirs =
    rawFocusDirs.length > 0 ? normalizeFocusDirs(rawFocusDirs, indexedRoot) : rawFocusDirs

  const filtered: CodegraphNode[] = []
  for (const n of hits) {
    const path = filePathByID.get(n.fileID) ?? ""
    if (rawFocusDirs.length > 0 && !pathMatchesFocusDirs(path, normalizedFocusDirs)) continue
    filtered.push(n)
  }

  if (rawFocusDirs.length === 0 && filtered.length > 1) {
    const productHits = filtered.filter((n) => {
      const path = filePathByID.get(n.fileID) ?? ""
      return PRODUCT_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))
    })
    if (productHits.length > 0) return productHits
  }

  return filtered
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
          const file = yield* resolveFileByPath(repo as never, input.file, meta?.indexedRoot)
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
        // double-prefix the comparison. Also needed for the product-package
        // tie-breaker below, which compares repo-relative display paths.
        const needsMeta = hasFocusDirs || (nodes.length > 1 && derivation === "name-exact")
        const meta = needsMeta ? yield* repo.getMeta() : undefined
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
          for (const f of files) filePathByID.set(f.id, toRepoRelativePath(f.path, meta?.indexedRoot))

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
          // Batch file lookup for the product-package tie-breaker so the
          // unscoped path stops issuing one query per node too.
          const candidateFileIDs = Array.from(new Set(nodes.map((n) => n.fileID)))
          const files = yield* repo.filesByIDs(candidateFileIDs)
          const filePathByNodeID = new Map<string, string>()
          for (const f of files) {
            for (const node of nodes) {
              if (node.fileID === f.id) filePathByNodeID.set(node.id, toRepoRelativePath(f.path, meta?.indexedRoot))
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

    // Module-resolution helpers for import-binding test evidence. The
    // persisted `codegraph_bindings` rows carry raw module specifiers; we
    // normalize both sides (extension-stripped, slash-normalized) and resolve
    // relative specifiers against the importing file's directory so a test
    // that does `import { X } from "../../src/foo"` matches the target
    // module `packages/core/src/foo.ts`.
    const normalizeModulePath = (p: string): string =>
      p.replace(/\\/g, "/").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, "")

    const moduleDirOf = (p: string): string => {
      const norm = normalizeModulePath(p)
      const i = norm.lastIndexOf("/")
      return i >= 0 ? norm.slice(0, i) : ""
    }

    const resolveRelativeModule = (fromFilePath: string, source: string): string => {
      const base = moduleDirOf(fromFilePath)
      const joined = base ? `${base}/${source}` : source
      const segments: string[] = []
      for (const seg of joined.split("/")) {
        if (seg === "..") {
          if (segments.length > 0) segments.pop()
        } else if (seg !== "." && seg !== "") {
          segments.push(seg)
        }
      }
      return segments.join("/")
    }

    const importBindingMatchesTarget = (
      binding: CodegraphBinding,
      fromFilePath: string,
      targetSearchName: string,
      targetModuleBase: string,
    ): boolean => {
      const names = [binding.importedName, binding.exportName, binding.localName].filter(
        (n): n is string => Boolean(n),
      )
      if (names.includes(targetSearchName)) return true
      if (!binding.source) return false
      const resolved = binding.source.startsWith(".")
        ? resolveRelativeModule(fromFilePath, binding.source)
        : binding.source
      const normalized = normalizeModulePath(resolved)
      return (
        normalized === targetModuleBase ||
        targetModuleBase.endsWith("/" + normalized) ||
        normalized.endsWith("/" + targetModuleBase)
      )
    }

    // Confidence per test-match derivation. `substring-low-confidence` is
    // deliberately ~10 so an evidence-free raw-code hit can never rank as a
    // real test hit.
    const TEST_DERIVATION_CONFIDENCE: Record<TestMatchDerivation, number> = {
      tested_by: 100,
      references: 80,
      "import-binding": 60,
      "substring-low-confidence": 10,
    }

    const findTests = (
      input: {
        symbol: string
        symbolID?: string
        limit?: number
      },
      ctx?: QueryContext,
    ): Effect.Effect<
      {
        tests: readonly CodegraphNode[]
        results: readonly TestMatch[]
        notFound: boolean
        derivation: TestMatchDerivation | "none"
        fallbackReason?: string
      },
      never,
      never
    > =>
      Effect.gen(function* () {
        // Phase 4: rank test matches by evidence. `tested_by` edges are
        // exact; calls/references edges are strong; resolved import
        // bindings are moderate. Raw code-substring matches are surfaced
        // ONLY as explicit `substring-low-confidence` diagnostics — a helper
        // whose code merely mentions the target name must never be reported
        // as a normal test hit.
        // Discover test files by either `kind = "test"` OR a `.test/.spec`
        // path pattern so we cover fixtures that omit the kind field.
        const testFilePatterns = [".test.ts", ".spec.ts", "test_", "_test.go", "_test.py", ".test.tsx", ".spec.tsx"]
        // Shared load (query/impact path) or one-off light load (standalone
        // `tests` entry): the files table + metadata-only node projection are
        // loaded once per call. The `code` column is fetched only for the
        // bounded candidate-test set below — the one consumer that needs it
        // (substring diagnostic matching).
        const allFiles = ctx?.allFiles ?? (yield* repo.listAllFiles())
        const allNodesLight = ctx?.allNodesLight ?? (yield* repo.searchNodesLight({ limit: 100000 }))
        const testFileIDs = new Set(
          allFiles
            .filter((f) => testFilePatterns.some((p) => f.path.toLowerCase().includes(p.toLowerCase())))
            .map((f) => f.id),
        )
        // Derive the `kind = "test"` set from the shared light projection
        // (id/fileID/kind are all present) instead of a second
        // listNodesByKind + full listAllNodes pass — the same ids either way.
        const testNodeIDs = new Set(allNodesLight.filter((n) => n.kind === "test").map((n) => n.id))
        const candidateTestNodeIDs = allNodesLight
          .filter((n) => testNodeIDs.has(n.id) || testFileIDs.has(n.fileID))
          .map((n) => n.id)
        // Bounded fetch of FULL candidate nodes — only the test candidates,
        // never the whole table.
        const candidateTestNodes =
          candidateTestNodeIDs.length > 0 ? yield* repo.nodesByIDs(candidateTestNodeIDs) : []

        const limit =
          input.limit === undefined ? 50 : Math.max(1, Math.min(500, Math.floor(input.limit)))

        let targetNode: CodegraphNode | undefined
        let targetFile: CodegraphFile | undefined
        let ambiguityNote: string | undefined

        if (input.symbolID) {
          targetNode = yield* repo.nodeByID(input.symbolID)
          targetFile = targetNode ? yield* repo.getFile(targetNode.fileID) : undefined
          if (!targetNode || !targetFile) return { tests: [], results: [], notFound: true, derivation: "none" }
        } else {
          const symbolResult = yield* findSymbol({ name: input.symbol })
          if (symbolResult.nodes.length === 0) {
            return { tests: [], results: [], notFound: true, derivation: "none" }
          }
          const searchName = input.symbol.includes(".") ? input.symbol.split(".").pop()! : input.symbol
          const exactMatch = symbolResult.nodes.find((n) => n.name === searchName)
          targetNode = yield* repo.nodeByID((exactMatch ?? symbolResult.nodes[0])!.id)
          targetFile = targetNode ? yield* repo.getFile(targetNode.fileID) : undefined
          if (!targetNode || !targetFile) return { tests: [], results: [], notFound: true, derivation: "none" }
          if (symbolResult.ambiguity && symbolResult.ambiguity.total > 1) {
            ambiguityNote = `"${input.symbol}" matched ${symbolResult.ambiguity.total} candidate node(s); tests resolved against ${targetNode.name}`
          }
        }

        if (candidateTestNodes.length === 0) {
          return {
            tests: [],
            results: [],
            notFound: false,
            derivation: "none",
            ...(ambiguityNote ? { fallbackReason: ambiguityNote } : {}),
          }
        }

        const targetSearchName = input.symbol.includes(".") ? input.symbol.split(".").pop()! : input.symbol
        const targetModuleBase = normalizeModulePath(targetFile.path)

        // Load the persisted import/export bindings for the candidate test
        // files once, so import-binding evidence never re-parses source.
        const candidateFileIDs = Array.from(new Set(candidateTestNodes.map((n) => n.fileID)))
        const bindings =
          candidateFileIDs.length > 0 ? yield* repo.bindingsByFileIDs({ fileIDs: candidateFileIDs }) : []
        const bindingsByFile = new Map<string, CodegraphBinding[]>()
        for (const b of bindings) {
          const list = bindingsByFile.get(b.fileID) ?? []
          list.push(b)
          bindingsByFile.set(b.fileID, list)
        }

        const candidateIDs = candidateTestNodes.map((t) => t.id)
        const [incomingToCandidates, outgoingFromCandidates] = yield* Effect.all([
          repo.edgesToBatch(candidateIDs),
          repo.edgesFromBatch(candidateIDs),
        ])

        // nodeID -> best (highest-confidence) match. A node can be reachable
        // by several signals; the strongest derivation wins.
        const matches = new Map<string, TestMatch>()
        const consider = (node: CodegraphNode, derivation: TestMatchDerivation) => {
          const confidence = TEST_DERIVATION_CONFIDENCE[derivation]
          const existing = matches.get(node.id)
          if (!existing || confidence > existing.confidence) {
            matches.set(node.id, { node, derivation, confidence })
          }
        }

        // 1) `tested_by` edges pointing AT a test node FROM the symbol —
        // strongest evidence.
        for (const edge of incomingToCandidates) {
          if (edge.kind !== "tested_by" || edge.fromNodeID !== targetNode.id) continue
          const testNode = candidateTestNodes.find((t) => t.id === edge.toNodeID)
          if (testNode) consider(testNode, "tested_by")
        }

        // 2) calls/references edges FROM each test node TO the symbol —
        // strong evidence. A `references` edge derived purely from a name
        // appearing in code (`heuristic-name`) is the substring-equivalent
        // evidence the strict policy forbids treating as a real test hit — a
        // mock helper whose body merely mentions the symbol's name must not
        // rank above an evidence-backed test. Real `references` come from
        // resolved import bindings (`binding-resolved` / `service-tag`),
        // same-file usage, or hand-seeded graphs with unknown provenance
        // (pre-migration rows normalize to undefined/0 — treat as unknown,
        // not heuristic). `calls` edges always mean an actual invocation, so
        // they always count.
        const referencedBy = new Set<string>()
        for (const edge of outgoingFromCandidates) {
          if ((edge.kind !== "calls" && edge.kind !== "references") || edge.toNodeID !== targetNode.id) continue
          if (edge.kind === "references" && edge.derivation === "heuristic-name") continue
          referencedBy.add(edge.fromNodeID)
        }
        for (const testNode of candidateTestNodes) {
          if (referencedBy.has(testNode.id)) consider(testNode, "references")
        }

        // 3) resolved import bindings — the test file imports the target
        // module or the target symbol by name.
        for (const testNode of candidateTestNodes) {
          const fileBindings = bindingsByFile.get(testNode.fileID) ?? []
          if (
            fileBindings.some((b) =>
              importBindingMatchesTarget(b, targetFile.path, targetSearchName, targetModuleBase),
            )
          ) {
            consider(testNode, "import-binding")
          }
        }

        // 4) raw code substring — explicitly low-confidence diagnostic ONLY.
        // Never a normal test hit; a node already backed by evidence is not
        // re-flagged.
        for (const testNode of candidateTestNodes) {
          if (matches.has(testNode.id) || !testNode.code) continue
          if (
            testNode.code.includes(targetSearchName) ||
            (targetModuleBase.length > 0 && testNode.code.includes(targetModuleBase))
          ) {
            consider(testNode, "substring-low-confidence")
          }
        }

        const ordered = [...matches.values()].sort(
          (a, b) => b.confidence - a.confidence || a.node.name.localeCompare(b.node.name),
        )
        const results = ordered.slice(0, limit)
        const tests = results.filter((r) => r.derivation !== "substring-low-confidence").map((r) => r.node)
        const evidenceCount = results.filter((r) => r.derivation !== "substring-low-confidence").length
        const substringCount = results.filter((r) => r.derivation === "substring-low-confidence").length

        let fallbackReason = ambiguityNote
        if (evidenceCount === 0 && substringCount > 0) {
          const note =
            `no graph evidence connected tests to "${input.symbol}"; ` +
            `${substringCount} node(s) matched by raw code substring and are surfaced as low-confidence diagnostics only`
          fallbackReason = fallbackReason ? `${fallbackReason}; ${note}` : note
        }

        const derivation: TestMatchDerivation | "none" = results[0]?.derivation ?? "none"
        return {
          tests,
          results,
          notFound: false,
          derivation,
          ...(fallbackReason ? { fallbackReason } : {}),
        }
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

    // Load the files table + light node projection + graph meta exactly once
    // per invocation. Every consumer below (findTests, queryWithContext,
    // impact) shares this instead of re-running listAllFiles/listAllNodes.
    const loadQueryContext = (): Effect.Effect<QueryContext, never, never> =>
      Effect.gen(function* () {
        const [allFiles, allNodesLight, meta] = yield* Effect.all([
          repo.listAllFiles(),
          repo.searchNodesLight({ limit: 100000 }),
          repo.getMeta(),
        ])
        return { allFiles, allNodesLight, meta }
      })

    const queryWithContext = (
      input: {
        query: string
        limit?: number
        workspace?: WorkspaceContext
      },
      ctx: QueryContext,
    ): Effect.Effect<RepositoryContext, never, never> =>
      Effect.gen(function* () {
        const { allFiles, allNodesLight, meta } = ctx
        const indexedRoot = meta?.indexedRoot

        const fileByPath = yield* resolveFileByPath(repo as never, input.query, indexedRoot)
        const symbolResult = yield* findSymbol({ name: input.query, workspace: input.workspace })
        const fileMatches: CodegraphNode[] = fileByPath
          ? allNodesLight.filter((n) => n.fileID === fileByPath.id)
          : []

        // Phase 3: run FTS for ALL queries (not just multi-token). The
        // trigram tokenizer + bm25 column weights added in
        // 20260801120000_codegraph_fts_tokenize make single-token
        // identifier queries (e.g. `bumpVersion`, `BuildService`) rank the
        // right symbol without the noise floor the old `unicode61` + single
        // weight design produced. The pre-Phase-3 rationale for gating FTS
        // to multi-token queries was that FTS over a one-word query
        // drowned the `findSymbol` name-exact / code-substring contribution.
        // The new weighting puts name hits ahead of any code-only hit, so
        // the gate is no longer needed.
        //
        // focusDirs parity: `findSymbol` filters its candidates to the
        // requested focusDirs before returning; FTS does not (the FTS5
        // match operator has no `WHERE file.path LIKE ...` clause). To
        // keep the post-Phase-3 result identical to the pre-Phase-3
        // result when the caller passed focusDirs, the FTS hit list is
        // post-filtered by the same `pathMatchesFocusDirs` check. The
        // out-of-scope diagnostics emitted by `findSymbol` (kept,
        // empty, ambiguous) are still sourced from `symbolResult` so
        // the caller's behavior on out-of-scope queries is unchanged.
        const rawFtsHits = yield* repo.ftsSearchNodes({ query: input.query, limit: input.limit ?? 50 })
        const ftsHits = applyFocusDirsFilter(rawFtsHits, input.workspace, indexedRoot, allFiles)
        const ftsDerivation = ftsHits.length > 0 ? ("fts-bm25" as const) : undefined

        const seen = new Set<string>()
        const symbols: CodegraphNode[] = []
        for (const hit of ftsHits) {
          if (!seen.has(hit.id)) {
            seen.add(hit.id)
            symbols.push(hit)
          }
        }
        const findSymbolContribution = symbolResult.nodes.filter((n) => n.kind !== "doc")
        for (const n of [...findSymbolContribution, ...fileMatches]) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            symbols.push(n)
          }
        }

        const testsResult = symbols.length > 0
          ? yield* findTests({ symbol: input.query }, ctx)
          : {
              tests: [] as readonly CodegraphNode[],
              results: [] as readonly TestMatch[],
              notFound: true,
              derivation: "none" as const,
            }

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
        if (testsResult.fallbackReason) {
          diagnostics.push({
            kind: "test-resolution-fallback",
            message: testsResult.fallbackReason,
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

        // Phase 4 (P3): real ranking via ranking/rank.ts — never ship zeros
        // labeled as signals. Per-symbol features come from the same signals
        // the search cascade uses: name equality (exact), FTS hit order
        // (bm25), the indexed `in_degree` column (graph), and focusDirs
        // membership (workspace). Traversal behavior is untouched — this is
        // purely the ranking output.
        const filePathByID = new Map<string, string>()
        for (const f of allFiles) filePathByID.set(f.id, toRepoRelativePath(f.path, indexedRoot))
        const queryLower = input.query.toLowerCase()
        const normalizedFocusDirs =
          (input.workspace?.focusDirs.length ?? 0) > 0
            ? normalizeFocusDirs(input.workspace!.focusDirs, indexedRoot)
            : []
        const ftsOrder = new Map<string, number>()
        ftsHits.forEach((hit, idx) => {
          if (!ftsOrder.has(hit.id)) ftsOrder.set(hit.id, idx)
        })
        const rankedSymbols = rank(
          symbols.map((n) => ({
            candidate: n,
            query: input.query,
            exactMatch: n.name.toLowerCase() === queryLower,
            prefixMatch: n.name.toLowerCase().startsWith(queryLower),
            camelMatch: false,
            snakeMatch: false,
            bm25Score: ftsOrder.has(n.id)
              ? Math.max(0, 1 - ftsOrder.get(n.id)! / Math.max(ftsHits.length, 1))
              : 0,
            fuzzyDistance: Infinity,
            qualifiedMatch: false,
            directCallers: n.inDegree ?? 0,
            directCallees: 0,
            gitFrequency: 0,
            workspaceProximity:
              normalizedFocusDirs.length > 0 &&
              pathMatchesFocusDirs(filePathByID.get(n.fileID) ?? "", normalizedFocusDirs)
                ? 1
                : 0,
            failingTests: 0,
          })),
        )
        const topRanked = rankedSymbols.reduce<RankingResult | undefined>(
          (best, r) => (best === undefined || r.score > best.score ? r : best),
          undefined,
        )
        const ranking = topRanked ?? {
          score: 0,
          signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 },
        }

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
          ...(testsResult.results.length > 0
            ? { testsDetailed: testsResult.results.filter((r) => bucketFileIDs.has(r.node.fileID)) }
            : {}),
          docs,
          configs,
          git: { recentCommits, ownership },
          workspace: input.workspace,
          diagnostics,
          ranking: {
            score: ranking.score,
            signals: ranking.signals,
            workspace: input.workspace,
          },
          ...(symbolResult.ambiguity ? { ambiguity: symbolResult.ambiguity } : {}),
        } satisfies RepositoryContext
      })

    const query = (input: {
      query: string
      limit?: number
      workspace?: WorkspaceContext
    }): Effect.Effect<RepositoryContext, never, never> =>
      Effect.gen(function* () {
        const ctx = yield* loadQueryContext()
        return yield* queryWithContext(input, ctx)
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
        const relatedTestsDetailed = ctx.testsDetailed?.filter((r) =>
          ctx.tests.some((t) => t.id === r.node.id),
        )

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

        // Caveat from v2 probes: test doubles (mock services, `makeMockRepo`,
        // `Service` classes in `*.test.ts`) were polluting the entrypoints
        // and direct callers list. Re-rank by file path so test files drop
        // out of source-intent fields while remaining visible inside
        // `relatedTests`. The path lookup is one round-trip over the union of
        // fileIDs from both BFS result sets — bounded by `defaultLimit`.
        const filterFileIDs = new Set<string>()
        for (const n of directCallersSet.values()) filterFileIDs.add(n.fileID)
        for (const n of transitiveSet.values()) filterFileIDs.add(n.fileID)
        const filterFiles = yield* (repo as CodegraphRepoInterface).filesByIDs([...filterFileIDs])
        const pathByID = new Map(filterFiles.map((f) => [f.id, f.path]))
        const isTestFile = (id: string): boolean => {
          const p = pathByID.get(id)
          return p ? isTestFilePath(p) : false
        }
        const isSource = (n: CodegraphNode): boolean => !isTestFile(n.fileID)
        for (const [id, node] of [...directCallersSet.entries()]) {
          if (!isSource(node)) directCallersSet.delete(id)
        }
        for (const [id, node] of [...transitiveSet.entries()]) {
          if (!isSource(node)) transitiveSet.delete(id)
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
          ...(relatedTestsDetailed ? { relatedTestsDetailed } : {}),
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
          ...(ctx.diagnostics && ctx.diagnostics.length > 0 ? { diagnostics: ctx.diagnostics } : {}),
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
        // Load the files + light-nodes + meta context ONCE and reuse it for
        // the query() pipeline below. Previously the file-miss path ran
        // query() (its own listAllFiles/listAllNodes/getMeta + BFS + tests)
        // and the resolved-file path re-ran query() at the end — so the
        // table loads happened twice per impact() call. The `query` string
        // (`input.path`) and workspace are passed through exactly as before.
        const qctx = yield* loadQueryContext()
        const file = yield* resolveFileByPath(repo as never, input.path, qctx.meta?.indexedRoot)
        if (!file) {
          const ctx = yield* queryWithContext({ query: input.path, workspace: input.workspace }, qctx)
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
        const ctx = yield* queryWithContext({ query: input.path, workspace: input.workspace }, qctx)
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
          // Phase 7 follow-up: target-not-resolved is a distinct state
          // from no-source-callers — never collapse into a single
          // "unused" conclusion. The slice already carries
          // `status: "failed"` and a `reason` from the resolver miss.
          return {
            ...slc,
            directCallers: [] as readonly CodegraphNode[],
            transitiveDependents: [] as readonly CodegraphNode[],
          }
        }

        // Phase 4: never silently anchor to `symbols[0]` when the resolver
        // genuinely returned multiple candidates — surface the ambiguity as
        // a structured diagnostic so the caller can disambiguate.
        const traceDiagnostics: Array<{ kind: string; message: string }> = []
        if (ctx.ambiguity && ctx.ambiguity.total > 1) {
          traceDiagnostics.push({
            kind: "ambiguous-symbol",
            message:
              `"${input.symbol}" matched ${ctx.ambiguity.total} candidate node(s); ` +
              `trace anchored to "${ctx.symbols[0]?.name ?? "unknown"}" — pass focusDirs to disambiguate`,
          })
        }

        const anchor = ctx.symbols[0]!
        const maxDepth = input.depth ?? 2
        const limit = Math.max(1, Math.min(1000, input.limit ?? 50))

        const tagged = yield* findRelatedWithDepth({ nodeID: anchor.id, depth: maxDepth })

        const isCodeLike = (k: CodegraphNode["kind"]) =>
          k === "function" || k === "class" || k === "method"

        const bfsCallers: CodegraphNode[] = []
        const transitiveTagged: Array<{ node: CodegraphNode; depth: number }> = []

        for (const t of tagged) {
          if (!isCodeLike(t.node.kind)) continue
          if (t.depth === 1) {
            bfsCallers.push(t.node)
          } else {
            transitiveTagged.push({ node: t.node, depth: t.depth })
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

        // Preserve the slice-derived callers (rich; from dependents() in
        // `slice`); only fall back to the BFS findings when the slice had
        // nothing. Issue #1: trace was wiping callers under sparse-edge
        // symbols despite `intel.explain` returning the same callers fine.
        const directCallers = slc.directCallers.length > 0 ? [...slc.directCallers] : bfsCallers

        // Phase 7 follow-up: build a structured diagnostic list so the
        // caller can distinguish "no-source-callers" from
        // "no-edges-found" from "out-of-scope". The existing
        // ArchitecturalSlice already has free-form `reason`; we add
        // explicit `diagnostics` entries the tool can surface. Any
        // diagnostics propagated from the query context (ambiguity,
        // test-resolution fallback) are preserved ahead of trace-specific
        // findings.
        const diagnostics: Array<{ kind: string; message: string }> = [
          ...(slc.diagnostics ?? []),
          ...traceDiagnostics,
        ]
        if (directCallers.length === 0 && visibleTransitive.length === 0) {
          // No source intent callers at all. Distinguish "no edges
          // exist" from "no source callers" — if the BFS found test
          // callers but they were filtered out, surface that.
          const testOnlyCallers = bfsCallers.length > 0 && directCallers.length === 0
          if (testOnlyCallers) {
            diagnostics.push({
              kind: "no-source-callers",
              message: "only test-file callers reference this symbol; no production callers were found",
            })
          } else {
            diagnostics.push({
              kind: "no-edges-found",
              message: "no callers or dependents reference this symbol in the current graph",
            })
          }
        }

        return {
          ...slc,
          directCallers,
          transitiveDependents: visibleTransitive,
          entrypoints: directCallers,
          moreAvailable: moreDependents > 0 ? { dependents: moreDependents } : undefined,
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
        } satisfies ArchitecturalSlice
      })

    const tests = (
      input: { symbol: string; limit?: number },
    ): Effect.Effect<{
      tests: readonly CodegraphNode[]
      results: readonly TestMatch[]
      notFound: boolean
      derivation: TestMatchDerivation | "none"
      fallbackReason?: string
    }, never, never> =>
      Effect.gen(function* () {
        return yield* findTests(input)
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
          const file = yield* resolveFileByPath(repo as never, input.path, meta?.indexedRoot)
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
