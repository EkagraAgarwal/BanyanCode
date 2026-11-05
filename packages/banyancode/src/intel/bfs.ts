import type { BfsGraph, BfsOptions as SharedBfsOptions } from "../codegraph/bfs.js"
import { bfsPure } from "../codegraph/bfs.js"
import { Effect } from "effect"
import type { CodegraphPort } from "./codegraph-port.js"
import type { EdgeKind, GraphEdge, GraphNode } from "./types.js"

/**
 * Breadth-first graph walk over the read-only `CodegraphPort`.
 *
 * The algorithm lives in `src/codegraph/bfs.ts`; this module only projects the
 * port onto its batched-read shape. `CodegraphPort` and `CodegraphRepo` rows
 * are structurally identical (`GraphNode`/`GraphEdge` vs
 * `CodegraphNode`/`CodegraphEdge`), so no mapping layer is needed.
 */

export type BfsDirection = SharedBfsOptions["direction"]
export type BfsOptions = SharedBfsOptions<EdgeKind>
export type BfsTaggedResult = { readonly node: GraphNode; readonly depth: number }
export type BfsRun = {
  readonly results: ReadonlyArray<BfsTaggedResult>
  readonly edges: ReadonlyArray<GraphEdge>
  readonly truncated: boolean
}

const portGraph = (port: CodegraphPort): BfsGraph<GraphNode, GraphEdge> => ({
  edgesFromBatch: (nodeIDs) => port.edgesFrom(nodeIDs),
  edgesToBatch: (nodeIDs) => port.edgesTo(nodeIDs),
  nodesByIDs: (ids) => port.nodesByIDs(ids),
})

export const bfs = (port: CodegraphPort, options: BfsOptions): Effect.Effect<BfsRun> =>
  bfsPure(portGraph(port), options)
