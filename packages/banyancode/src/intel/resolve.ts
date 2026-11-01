import { Effect } from "effect"
import type { CodegraphPort } from "./codegraph-port.js"
import { isTestFilePath } from "./paths.js"
import type { EdgeKind, GraphFile, GraphMeta, GraphNode } from "./types.js"

/**
 * Shared symbol resolver, ported from v1
 * `packages/core/src/banyancode/symbol-resolver.ts`.
 *
 * Fixed priority order, first non-empty candidate set wins:
 *   0. node-ID passthrough (`file:function:name:line`)
 *   1. `Context.Service` tag
 *   2. exact name
 *   3. qualified split (`Namespace.leaf`, `Ns::leaf`)
 *   4. FTS5 bm25 scoped to the qualified parent's files
 *   5. code-substring / leaf equality
 *   6. name LIKE
 */

export type ResolutionDerivation =
  | "tag-fallback"
  | "name-exact"
  | "qualified-split"
  | "code-substring"
  | "name-like"
  | "fts-bm25"

export interface ResolvedTarget {
  readonly nodeID: string
  readonly node: GraphNode
  readonly candidates: ReadonlyArray<GraphNode>
  readonly derivation: ResolutionDerivation
}

export interface ResolutionMiss {
  readonly target: string
  readonly tried: ReadonlyArray<ResolutionDerivation>
}

export type ResolutionResult =
  | { readonly _tag: "Ok"; readonly value: ResolvedTarget }
  | { readonly _tag: "Miss"; readonly value: ResolutionMiss }

export interface ResolveInput {
  readonly target: string
  readonly kind?: GraphNode["kind"]
  readonly fileID?: string
  readonly limit?: number
  readonly allowKeywordFallback?: boolean
}

const NODE_ID_MARKERS = [
  ":function:",
  ":method:",
  ":class:",
  ":type:",
  ":variable:",
  ":route:",
  ":test:",
  ":file:",
  ":generated:",
]

const dedupeByID = (nodes: readonly GraphNode[]): GraphNode[] => {
  const seen = new Set<string>()
  const out: GraphNode[] = []
  for (const node of nodes) {
    if (seen.has(node.id)) continue
    seen.add(node.id)
    out.push(node)
  }
  return out
}

const KIND_RANK: Partial<Record<GraphNode["kind"], number>> = {
  class: 0,
  function: 1,
  method: 2,
  type: 3,
  variable: 5,
  route: 7,
  test: 8,
  file: 9,
  generated: 11,
}

const sortBySpecificity = (nodes: GraphNode[], lowerTarget: string): GraphNode[] => {
  const score = (node: GraphNode): number => {
    let value = (KIND_RANK[node.kind] ?? 99) * 10
    if (node.name.toLowerCase() === lowerTarget) value -= 100
    return value
  }
  // `node.id` tiebreak keeps resolution deterministic across rebuilds.
  return nodes
    .slice()
    .sort((a, b) => {
      const delta = score(a) - score(b)
      if (delta !== 0) return delta
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

export const resolveGraphTarget = (
  port: CodegraphPort,
  input: ResolveInput,
): Effect.Effect<ResolutionResult> =>
  Effect.gen(function* () {
    const target = input.target.trim()
    const qualified = target.replace(/::/g, ".")
    const empty: ResolutionResult = { _tag: "Miss", value: { target, tried: [] } }
    if (!target) return empty

    const tried: ResolutionDerivation[] = []
    const limit = input.limit ?? 25
    const allowKeywordFallback = input.allowKeywordFallback ?? true

    const byKind = (nodes: readonly GraphNode[]): GraphNode[] =>
      input.kind ? nodes.filter((node) => node.kind === input.kind) : [...nodes]
    const byFile = (nodes: readonly GraphNode[]): GraphNode[] =>
      input.fileID ? nodes.filter((node) => node.fileID === input.fileID) : [...nodes]

    const toResult = (nodes: GraphNode[], derivation: ResolutionDerivation): ResolutionResult => {
      const head = nodes[0]
      if (!head) return { _tag: "Miss", value: { target, tried } }
      return { _tag: "Ok", value: { nodeID: head.id, node: head, candidates: nodes, derivation } }
    }

    // Test doubles in `*.test.ts` declare the same `Context.Service` tag as
    // the source. Prefer non-test files so canonical resolution never lands on
    // a test class.
    const reorderNonTestFirst = (nodes: readonly GraphNode[]): Effect.Effect<GraphNode[]> =>
      Effect.gen(function* () {
        if (nodes.length <= 1) return [...nodes]
        const fileIDs = [...new Set(nodes.map((node) => node.fileID))]
        const files = yield* port.listFiles()
        const pathByID = new Map(files.filter((file) => fileIDs.includes(file.id)).map((file) => [file.id, file.path]))
        const isTest = (node: GraphNode): boolean => {
          const path = pathByID.get(node.fileID)
          return path ? isTestFilePath(path) : false
        }
        return [...nodes.filter((node) => !isTest(node)), ...nodes.filter(isTest)]
      })

    // 0) Node-ID passthrough. Windows drive letters contain a colon, so a
    //    bare `:` is not enough; require a kind marker.
    if (NODE_ID_MARKERS.some((marker) => target.includes(marker))) {
      const byID = yield* port.nodeByID(target)
      if (byID && byKind([byID]).length > 0 && byFile([byID]).length > 0) {
        return toResult([byID], "name-exact")
      }
    }

    // 1) Context.Service tag.
    if (port.findByServiceTag) {
      const tagHits = dedupeByID(byFile(byKind(yield* port.findByServiceTag(target))))
      tried.push("tag-fallback")
      if (tagHits.length > 0) {
        const ordered = yield* reorderNonTestFirst(tagHits)
        return toResult(ordered.slice(0, limit), "tag-fallback")
      }
    }

    // 2) Exact name.
    const exactScan = port.findByExactName
      ? yield* port.findByExactName({ name: target, limit: 500 })
      : (yield* port.searchByName({ name: target, limit: 500 })).filter((node) => node.name === target)
    const exactHits = byFile(byKind(exactScan))
    tried.push("name-exact")
    if (exactHits.length > 0) {
      return toResult(dedupeByID(exactHits).slice(0, limit), "name-exact")
    }

    // 3) Qualified split.
    let parentFileIDs: ReadonlySet<string> | undefined
    if (qualified.includes(".")) {
      const parts = qualified.split(".")
      const leaf = parts[parts.length - 1] ?? ""
      const parentName = parts.slice(0, -1).join(".")
      if (leaf && parentName) {
        const [parentScan, leafScan] = yield* Effect.all([
          port.searchByName({ name: parentName, limit: 1000 }),
          port.searchByName({ name: leaf, limit: 1000 }),
        ])
        const validFileIDs = new Set(parentScan.filter((node) => node.name === parentName).map((node) => node.fileID))
        if (port.fileIDsByServiceName) {
          for (const fileID of yield* port.fileIDsByServiceName(parentName)) validFileIDs.add(fileID)
        }
        const validFiles = yield* port.listFiles()
        const pathByID = new Map(
          validFiles.filter((file) => validFileIDs.has(file.id)).map((file) => [file.id, file.path]),
        )
        for (const id of [...validFileIDs]) {
          const path = pathByID.get(id)
          if (path && isTestFilePath(path)) validFileIDs.delete(id)
        }
        parentFileIDs = validFileIDs
        const splitHits = leafScan.filter(
          (node) => node.name === leaf && validFileIDs.has(node.fileID) && (input.kind ? node.kind === input.kind : true),
        )
        tried.push("qualified-split")
        const filtered = input.fileID ? splitHits.filter((node) => node.fileID === input.fileID) : splitHits
        if (filtered.length > 0) {
          const full = yield* port.nodesByIDs(filtered.map((node) => node.id))
          const fullByID = new Map(full.map((node) => [node.id, node]))
          return toResult(
            dedupeByID(filtered.map((node) => fullByID.get(node.id) ?? node)).slice(0, limit),
            "qualified-split",
          )
        }
      }
    }

    if (!allowKeywordFallback) return { _tag: "Miss", value: { target, tried } }

    // 4) FTS5 bm25, scoped to the qualified parent's files.
    if (qualified.includes(".") && parentFileIDs !== undefined && port.searchFullText) {
      const leaf = qualified.split(".").pop()!.toLowerCase()
      const raw = yield* port.searchFullText({ query: leaf, limit: 20 }).pipe(Effect.orElseSucceed(() => []))
      const hits = dedupeByID(
        raw.filter((node) => parentFileIDs!.has(node.fileID) && (input.kind ? node.kind === input.kind : true)),
      )
      tried.push("fts-bm25")
      if (hits.length > 0) return toResult(hits.slice(0, limit), "fts-bm25")
    }

    // 5) Code-substring / leaf equality.
    const lowerTarget = qualified.toLowerCase()
    const leaf = qualified.includes(".") ? qualified.split(".").pop()!.toLowerCase() : lowerTarget
    const scoped = parentFileIDs !== undefined && parentFileIDs.size > 0
    const isShortLeaf = leaf.length < 6
    const nameMatches = (node: GraphNode): boolean => {
      if (isShortLeaf && !scoped) return false
      return node.name.toLowerCase() === lowerTarget || node.name.toLowerCase() === leaf
    }
    const lightNodes = yield* port.searchByName({ name: leaf, limit: 1000 })
    const ftsWidened = port.searchFullText
      ? yield* port.searchFullText({ query: leaf, limit: 50 }).pipe(Effect.orElseSucceed(() => []))
      : []
    const gated = [...lightNodes, ...ftsWidened].filter(
      (node) =>
        node.kind !== "file" &&
        (input.kind ? node.kind === input.kind : true) &&
        (!input.fileID || node.fileID === input.fileID) &&
        (scoped ? parentFileIDs!.has(node.fileID) : true),
    )
    const codeCandidates = gated.length > 0 ? yield* port.nodesByIDs(gated.map((node) => node.id)) : []
    const codeHits = sortBySpecificity(
      codeCandidates.filter((node) => nameMatches(node) || node.code?.toLowerCase().includes(lowerTarget) === true),
      lowerTarget,
    )
    tried.push("code-substring")
    if (codeHits.length > 0) {
      return toResult(dedupeByID(codeHits).slice(0, limit), "code-substring")
    }

    // 6) Name LIKE.
    const likeHits = byFile(byKind(yield* port.searchByName({ name: target, limit: 200 })))
    tried.push("name-like")
    if (likeHits.length > 0) {
      return toResult(dedupeByID(likeHits).slice(0, limit), "name-like")
    }

    return { _tag: "Miss", value: { target, tried } }
  })

/**
 * Normalize a caller-provided path against the indexed root so absolute
 * Windows paths, backslash paths and repo-relative paths all resolve.
 * Ported from v1 `buildPathCandidates` / `resolveFileByPath`.
 */
export const buildPathCandidates = (input: string, indexedRoot?: string): string[] => {
  const cleaned = input.replace(/\\/g, "/").trim()
  if (!cleaned) return []
  const root = indexedRoot ? indexedRoot.replace(/\\/g, "/").replace(/\/+$/, "") : undefined
  const out: string[] = [cleaned]
  if (root) {
    if (cleaned !== root && !cleaned.startsWith(root + "/")) {
      out.push(`${root}/${cleaned}`)
      out.push(`${root}${cleaned.startsWith("/") ? "" : "/"}${cleaned}`)
    }
    if (cleaned === root) out.push("")
    else if (cleaned.startsWith(root + "/")) out.push(cleaned.slice(root.length + 1))
  }
  return [...new Set(out)].filter((candidate) => candidate.length > 0)
}

export const resolveFileByPath = (
  port: CodegraphPort,
  input: string,
  indexedRoot?: string,
  allFiles?: readonly GraphFile[],
): Effect.Effect<GraphFile | undefined> =>
  Effect.gen(function* () {
    for (const candidate of buildPathCandidates(input, indexedRoot)) {
      const file = yield* port.getFileByPath(candidate)
      if (file) return file
    }
    const files = allFiles ?? (yield* port.listFiles())
    const normInput = input.replace(/\\/g, "/").replace(/^\.\//, "")
    const matches = files.filter((file) => {
      const path = file.path.replace(/\\/g, "/")
      return path === normInput || path.endsWith("/" + normInput) || path.endsWith(normInput)
    })
    return matches.length === 1 ? matches[0] : undefined
  })

export const toGraphMeta = (meta: GraphMeta | undefined): GraphMeta | undefined =>
  meta
    ? {
        graphBuiltAt: meta.graphBuiltAt,
        graphVersion: meta.graphVersion,
        graphCoverage: meta.graphCoverage,
        totalFiles: meta.totalFiles,
        totalNodes: meta.totalNodes,
        totalEdges: meta.totalEdges,
      }
    : undefined

export const CALLER_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(["calls", "references"])
export const DEPENDENCY_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(["calls", "references", "imports", "extends"])
export const ALL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set([
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
