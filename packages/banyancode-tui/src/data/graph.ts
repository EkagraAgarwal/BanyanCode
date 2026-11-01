import type { CodegraphEdge, CodegraphNode } from "./pending-rpc"

export interface GraphLayerCounts {
  readonly symbol: string
  readonly l1: number
  readonly l2: number
  readonly l3: number
}

export interface FocusedGraph {
  readonly root: CodegraphNode
  readonly callers: readonly CodegraphNode[]
  readonly dependents: readonly CodegraphNode[]
  readonly impact: readonly CodegraphNode[]
  readonly degree: ReadonlyMap<string, number>
}

const TRACE_STEP_LIMIT = 5000

/**
 * Adjacency + degree index over a codegraph snapshot. Mirrors the v1
 * CodegraphAnalyzer traversal: callers are inbound `calls`/`references` edges,
 * dependents are outbound edges, impact is the transitive outbound closure.
 */
export function focusGraph(
  nodes: readonly CodegraphNode[],
  edges: readonly CodegraphEdge[],
  focusID?: string,
): FocusedGraph | undefined {
  if (nodes.length === 0) return undefined
  const byID = new Map(nodes.map((node) => [node.id, node]))
  const inbound = new Map<string, CodegraphEdge[]>()
  const outbound = new Map<string, CodegraphEdge[]>()
  const degree = new Map<string, number>()
  const push = (map: Map<string, CodegraphEdge[]>, key: string, edge: CodegraphEdge) => {
    const list = map.get(key)
    if (list) list.push(edge)
    else map.set(key, [edge])
  }
  for (const edge of edges) {
    if (!byID.has(edge.fromNodeID) || !byID.has(edge.toNodeID)) continue
    push(outbound, edge.fromNodeID, edge)
    push(inbound, edge.toNodeID, edge)
    degree.set(edge.fromNodeID, (degree.get(edge.fromNodeID) ?? 0) + 1)
    degree.set(edge.toNodeID, (degree.get(edge.toNodeID) ?? 0) + 1)
  }
  const root =
    (focusID === undefined ? undefined : byID.get(focusID)) ??
    nodes.reduce((best, node) => ((degree.get(node.id) ?? 0) > (degree.get(best.id) ?? 0) ? node : best), nodes[0]!)
  const callers = (inbound.get(root.id) ?? [])
    .filter((edge) => edge.kind === "calls" || edge.kind === "references")
    .flatMap((edge) => byID.get(edge.fromNodeID) ?? [])
  const dependents = (outbound.get(root.id) ?? []).flatMap((edge) => byID.get(edge.toNodeID) ?? [])
  const seen = new Set<string>([root.id])
  const impact: CodegraphNode[] = []
  const queue = [root.id]
  let steps = 0
  while (queue.length > 0 && steps < TRACE_STEP_LIMIT) {
    steps += 1
    const current = queue.shift()!
    for (const edge of outbound.get(current) ?? []) {
      if (seen.has(edge.toNodeID)) continue
      seen.add(edge.toNodeID)
      const node = byID.get(edge.toNodeID)
      if (node) impact.push(node)
      queue.push(edge.toNodeID)
    }
  }
  return { root, callers, dependents, impact, degree }
}

export function layerCounts(focused: FocusedGraph | undefined): GraphLayerCounts | undefined {
  if (!focused) return undefined
  return {
    symbol: focused.root.name,
    l1: new Set(focused.callers.map((node) => node.id)).size,
    l2: focused.impact.length,
    l3: new Set(focused.dependents.map((node) => node.id)).size,
  }
}

export function graphFiles(nodes: readonly CodegraphNode[]): readonly string[] {
  return [...new Set(nodes.map((node) => node.fileID))]
}

export function nodeLocation(node: CodegraphNode | undefined): string {
  if (!node) return ""
  return node.startLine > 0 ? `:${node.startLine}` : ""
}
