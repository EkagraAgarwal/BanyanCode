import { Effect } from "effect"
import type { CodegraphEdge, CodegraphEdgeKind, CodegraphNode } from "../types"
import type { Interface as CodegraphRepoInterface } from "../codegraph-repo"

// Plan Phase 3: one internal BFS primitive parameterized by direction,
// edge kinds, depth, and result limit. It swaps the current and next
// frontier arrays after each depth (no `Array.shift()`). Each frontier is
// expanded with batched edge queries instead of one query per node. A node
// is marked visited at enqueue time so diamond-shaped graphs return each node
// exactly once.

export type BfsDirection = "outgoing" | "incoming" | "both"

export interface BfsOptions {
  readonly start: ReadonlyArray<string>
  readonly direction: BfsDirection
  readonly edgeKinds: ReadonlySet<CodegraphEdgeKind>
  /**
   * Optional per-direction edge-kind allowlist. When present, overrides
   * `edgeKinds` for the given direction. Lets `findRelatedWithDepth`
   * accept `calls/references/imports/extends` outgoing but only
   * `calls/references` incoming — the test invariant the existing
   * directional traversal relies on.
   */
  readonly outgoingEdgeKinds?: ReadonlySet<CodegraphEdgeKind>
  readonly incomingEdgeKinds?: ReadonlySet<CodegraphEdgeKind>
  readonly maxDepth: number
  readonly resultLimit?: number
}

export interface BfsTaggedResult {
  readonly node: CodegraphNode
  readonly depth: number
}

export interface BfsRun {
  readonly results: ReadonlyArray<BfsTaggedResult>
  readonly edges: ReadonlyArray<CodegraphEdge>
  readonly truncated: boolean
}

export type BfsRepo = Pick<
  CodegraphRepoInterface,
  "edgesFrom" | "edgesTo" | "edgesFromBatch" | "edgesToBatch" | "nodesByIDs"
>

// Run a single batched query for the whole frontier instead of one query
// per node. For a 1,000-node frontier this collapses 1,000 queries into 2.
const fetchFrontierEdges = (
  repo: BfsRepo,
  frontier: ReadonlyArray<string>,
  direction: BfsDirection,
): Effect.Effect<
  { readonly out: ReadonlyMap<string, ReadonlyArray<CodegraphEdge>>; readonly inc: ReadonlyMap<string, ReadonlyArray<CodegraphEdge>> },
  never,
  never
> =>
  Effect.gen(function* () {
    const empty = {
      out: new Map<string, ReadonlyArray<CodegraphEdge>>(),
      inc: new Map<string, ReadonlyArray<CodegraphEdge>>(),
    }
    if (frontier.length === 0) return empty

    const wantOut = direction === "outgoing" || direction === "both"
    const wantIn = direction === "incoming" || direction === "both"

    const outEdgesByID = new Map<string, ReadonlyArray<CodegraphEdge>>()
    if (wantOut) {
      const edges = yield* repo.edgesFromBatch(frontier)
      for (const e of edges) {
        const list = outEdgesByID.get(e.fromNodeID) ?? []
        outEdgesByID.set(e.fromNodeID, [...list, e])
      }
    }
    const inEdgesByID = new Map<string, ReadonlyArray<CodegraphEdge>>()
    if (wantIn) {
      const edges = yield* repo.edgesToBatch(frontier)
      for (const e of edges) {
        const list = inEdgesByID.get(e.toNodeID) ?? []
        inEdgesByID.set(e.toNodeID, [...list, e])
      }
    }
    return { out: outEdgesByID, inc: inEdgesByID }
  })

export const bfsPure = (
  repo: BfsRepo,
  options: BfsOptions,
): Effect.Effect<BfsRun, never, never> =>
  Effect.gen(function* () {
    const { start, direction, maxDepth } = options
    const outgoingKinds = options.outgoingEdgeKinds ?? options.edgeKinds
    const incomingKinds = options.incomingEdgeKinds ?? options.edgeKinds
    const wantOut = direction === "outgoing" || direction === "both"
    const wantIn = direction === "incoming" || direction === "both"
    const resultLimit = options.resultLimit ?? Infinity
    if (start.length === 0 || maxDepth <= 0) return { results: [], edges: [], truncated: false }

    const visited = new Set<string>(start)
    const depthOf = new Map<string, number>(start.map((id) => [id, 0]))
    const resultIDs: string[] = []
    const edges: CodegraphEdge[] = []
    const seenEdges = new Set<string>()
    let truncated = false

    let frontier = start.slice()
    let currentDepth = 0

    while (frontier.length > 0) {
      const nextDepth = currentDepth + 1
      if (nextDepth > maxDepth) break

      const fetched = yield* fetchFrontierEdges(repo, frontier, direction)
      const nextFrontier: string[] = []
      for (const id of frontier) {
        const candidates: Array<{ readonly edge: CodegraphEdge; readonly nextID: string; readonly kinds: ReadonlySet<CodegraphEdgeKind> }> = []
        if (wantOut) {
          for (const edge of fetched.out.get(id) ?? []) candidates.push({ edge, nextID: edge.toNodeID, kinds: outgoingKinds })
        }
        if (wantIn) {
          for (const edge of fetched.inc.get(id) ?? []) candidates.push({ edge, nextID: edge.fromNodeID, kinds: incomingKinds })
        }

        for (const { edge, nextID, kinds } of candidates) {
          if (!seenEdges.has(edge.id)) {
            seenEdges.add(edge.id)
            edges.push(edge)
          }
          if (!kinds.has(edge.kind)) continue
          if (visited.has(nextID)) continue
          visited.add(nextID)
          depthOf.set(nextID, nextDepth)
          nextFrontier.push(nextID)
          if (resultIDs.length < resultLimit) resultIDs.push(nextID)
          else truncated = true
        }
      }
      frontier = nextFrontier
      currentDepth = nextDepth
    }

    if (resultIDs.length > 0) {
      const fetched = yield* repo.nodesByIDs(resultIDs)
      const byID = new Map(fetched.map((n) => [n.id, n]))
      const results: BfsTaggedResult[] = []
      for (const id of resultIDs) {
        const node = byID.get(id)
        if (!node) continue
        results.push({ node, depth: depthOf.get(id) ?? 0 })
      }
      return { results, edges, truncated }
    }
    return { results: [], edges, truncated }
  })