import { Effect } from "effect"
import type { CodegraphPort } from "./codegraph-port.js"
import type { EdgeKind, GraphEdge, GraphNode } from "./types.js"

/**
 * Breadth-first graph walk, ported from v1
 * `repository-intelligence/bfs.ts`. One batched edge query per frontier level
 * (not one per node); a node is marked visited at enqueue time so diamonds
 * return exactly once.
 */

export type BfsDirection = "outgoing" | "incoming" | "both"

export interface BfsOptions {
  readonly start: ReadonlyArray<string>
  readonly direction: BfsDirection
  readonly edgeKinds: ReadonlySet<EdgeKind>
  readonly outgoingEdgeKinds?: ReadonlySet<EdgeKind>
  readonly incomingEdgeKinds?: ReadonlySet<EdgeKind>
  readonly maxDepth: number
  readonly resultLimit?: number
}

export interface BfsTaggedResult {
  readonly node: GraphNode
  readonly depth: number
}

export interface BfsRun {
  readonly results: ReadonlyArray<BfsTaggedResult>
  readonly edges: ReadonlyArray<GraphEdge>
  readonly truncated: boolean
}

const fetchFrontierEdges = (
  port: CodegraphPort,
  frontier: ReadonlyArray<string>,
  direction: BfsDirection,
): Effect.Effect<{
  readonly out: ReadonlyMap<string, ReadonlyArray<GraphEdge>>
  readonly inc: ReadonlyMap<string, ReadonlyArray<GraphEdge>>
}> =>
  Effect.gen(function* () {
    if (frontier.length === 0) return { out: new Map(), inc: new Map() }
    const wantOut = direction === "outgoing" || direction === "both"
    const wantIn = direction === "incoming" || direction === "both"

    const outEdgesByID = new Map<string, GraphEdge[]>()
    if (wantOut) {
      for (const edge of yield* port.edgesFrom(frontier)) {
        const list = outEdgesByID.get(edge.fromNodeID)
        if (list) list.push(edge)
        else outEdgesByID.set(edge.fromNodeID, [edge])
      }
    }
    const inEdgesByID = new Map<string, GraphEdge[]>()
    if (wantIn) {
      for (const edge of yield* port.edgesTo(frontier)) {
        const list = inEdgesByID.get(edge.toNodeID)
        if (list) list.push(edge)
        else inEdgesByID.set(edge.toNodeID, [edge])
      }
    }
    return { out: outEdgesByID, inc: inEdgesByID }
  })

export const bfs = (port: CodegraphPort, options: BfsOptions): Effect.Effect<BfsRun> =>
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
    const edges: GraphEdge[] = []
    const seenEdges = new Set<string>()
    let truncated = false

    let frontier = start.slice()
    let currentDepth = 0

    while (frontier.length > 0) {
      const nextDepth = currentDepth + 1
      if (nextDepth > maxDepth) break

      const fetched = yield* fetchFrontierEdges(port, frontier, direction)
      const nextFrontier: string[] = []
      for (const id of frontier) {
        const candidates: Array<{ edge: GraphEdge; nextID: string; kinds: ReadonlySet<EdgeKind> }> = []
        if (wantOut) {
          for (const edge of fetched.out.get(id) ?? []) {
            candidates.push({ edge, nextID: edge.toNodeID, kinds: outgoingKinds })
          }
        }
        if (wantIn) {
          for (const edge of fetched.inc.get(id) ?? []) {
            candidates.push({ edge, nextID: edge.fromNodeID, kinds: incomingKinds })
          }
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

    if (resultIDs.length === 0) return { results: [], edges, truncated }
    const fetchedNodes = yield* port.nodesByIDs(resultIDs)
    const byID = new Map(fetchedNodes.map((node) => [node.id, node]))
    const results: BfsTaggedResult[] = []
    for (const id of resultIDs) {
      const node = byID.get(id)
      if (node) results.push({ node, depth: depthOf.get(id) ?? 0 })
    }
    return { results, edges, truncated }
  })
