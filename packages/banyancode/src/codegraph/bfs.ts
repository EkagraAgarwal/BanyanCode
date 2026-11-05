import { Effect } from "effect"

// Plan Phase 3: one internal BFS primitive parameterized by direction,
// edge kinds, depth, and result limit. It swaps the current and next
// frontier arrays after each depth (no `Array.shift()`). Each frontier is
// expanded with batched edge queries instead of one query per node. A node
// is marked visited at enqueue time so diamond-shaped graphs return each node
// exactly once.
//
// Generic over the row shape so both graph views share one algorithm:
// `CodegraphRepo` rows (`CodegraphNode`/`CodegraphEdge`) and the read-only
// `CodegraphPort` projection (`GraphNode`/`GraphEdge`). The two shapes are
// structurally identical; only the pre-existing type names differ.

export type BfsDirection = "outgoing" | "incoming" | "both"

export interface BfsNode {
  readonly id: string
}

export interface BfsEdge {
  readonly id: string
  readonly fromNodeID: string
  readonly toNodeID: string
  readonly kind: string
}

export interface BfsOptions<K extends string = string> {
  readonly start: ReadonlyArray<string>
  readonly direction: BfsDirection
  readonly edgeKinds: ReadonlySet<K>
  /**
   * Optional per-direction edge-kind allowlist. When present, overrides
   * `edgeKinds` for the given direction. Lets `findRelatedWithDepth`
   * accept `calls/references/imports/extends` outgoing but only
   * `calls/references` incoming — the test invariant the existing
   * directional traversal relies on.
   */
  readonly outgoingEdgeKinds?: ReadonlySet<K>
  readonly incomingEdgeKinds?: ReadonlySet<K>
  readonly maxDepth: number
  readonly resultLimit?: number
}

export interface BfsTaggedResult<N extends BfsNode = BfsNode> {
  readonly node: N
  readonly depth: number
}

export interface BfsRun<N extends BfsNode = BfsNode, E extends BfsEdge = BfsEdge> {
  readonly results: ReadonlyArray<BfsTaggedResult<N>>
  readonly edges: ReadonlyArray<E>
  readonly truncated: boolean
}

/** The batched reads BFS needs; both graph repositories satisfy it. */
export interface BfsGraph<N extends BfsNode, E extends BfsEdge> {
  readonly edgesFromBatch: (nodeIDs: string[]) => Effect.Effect<ReadonlyArray<E>, never, never>
  readonly edgesToBatch: (nodeIDs: string[]) => Effect.Effect<ReadonlyArray<E>, never, never>
  readonly nodesByIDs: (ids: string[]) => Effect.Effect<ReadonlyArray<N>, never, never>
}

// Run a single batched query for the whole frontier instead of one query
// per node. For a 1,000-node frontier this collapses 1,000 queries into 2.
const fetchFrontierEdges = <N extends BfsNode, E extends BfsEdge>(
  graph: BfsGraph<N, E>,
  frontier: string[],
  direction: BfsDirection,
): Effect.Effect<
  { readonly out: ReadonlyMap<string, ReadonlyArray<E>>; readonly inc: ReadonlyMap<string, ReadonlyArray<E>> },
  never,
  never
> =>
  Effect.gen(function* () {
    const empty = {
      out: new Map<string, ReadonlyArray<E>>(),
      inc: new Map<string, ReadonlyArray<E>>(),
    }
    if (frontier.length === 0) return empty

    const wantOut = direction === "outgoing" || direction === "both"
    const wantIn = direction === "incoming" || direction === "both"

    // Accumulate with push instead of `[...list, e]` array-spread per edge —
    // the spread reallocates the whole list for every edge, which is
    // quadratic on wide frontiers. Output order is identical.
    const outEdgesByID = new Map<string, E[]>()
    if (wantOut) {
      for (const edge of yield* graph.edgesFromBatch(frontier)) {
        let list = outEdgesByID.get(edge.fromNodeID)
        if (!list) {
          list = []
          outEdgesByID.set(edge.fromNodeID, list)
        }
        list.push(edge)
      }
    }
    const inEdgesByID = new Map<string, E[]>()
    if (wantIn) {
      for (const edge of yield* graph.edgesToBatch(frontier)) {
        let list = inEdgesByID.get(edge.toNodeID)
        if (!list) {
          list = []
          inEdgesByID.set(edge.toNodeID, list)
        }
        list.push(edge)
      }
    }
    return { out: outEdgesByID, inc: inEdgesByID }
  })

export const bfsPure = <N extends BfsNode, E extends BfsEdge>(
  graph: BfsGraph<N, E>,
  options: BfsOptions<E["kind"] & string>,
): Effect.Effect<BfsRun<N, E>, never, never> =>
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
    const edges: E[] = []
    const seenEdges = new Set<string>()
    let truncated = false

    let frontier = start.slice()
    let currentDepth = 0

    while (frontier.length > 0) {
      const nextDepth = currentDepth + 1
      if (nextDepth > maxDepth) break

      const fetched = yield* fetchFrontierEdges(graph, frontier, direction)
      const nextFrontier: string[] = []
      for (const id of frontier) {
        const candidates: Array<{ readonly edge: E; readonly nextID: string; readonly kinds: ReadonlySet<string> }> = []
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
      const fetched = yield* graph.nodesByIDs(resultIDs)
      const byID = new Map(fetched.map((node) => [node.id, node]))
      const results: BfsTaggedResult<N>[] = []
      for (const id of resultIDs) {
        const node = byID.get(id)
        if (!node) continue
        results.push({ node, depth: depthOf.get(id) ?? 0 })
      }
      return { results, edges, truncated }
    }
    return { results: [], edges, truncated }
  })
