import type { CodegraphEdge, CodegraphFile, CodegraphNode } from "../../data/pending-rpc"

/**
 * The code-graph facts the File sheet reads, derived once per file from the
 * paged node and edge lists the host already serves. Nothing here is invented:
 * a file the graph has not indexed has no entry, and the sheet says so.
 */

export interface GraphFileInfo {
  readonly path: string
  readonly name: string
  /** Highest `endLine` of any node the graph indexed in this file. */
  readonly lines?: number
  /** Distinct files this one points at, by path. */
  readonly imports: readonly string[]
  /** Distinct files that point at this one, by path. */
  readonly dependents: readonly string[]
  /** Incoming nodes one hop away. */
  readonly direct: number
  /** Incoming nodes two or three hops away. */
  readonly transitive: number
}

export interface GraphData {
  readonly file: (path: string) => GraphFileInfo | undefined
}

export { blastScore, type BlastScore } from "../../data/understory-map"

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

const BFS_DEPTH = 3
const RESULT_LIMIT = 500

export function buildGraphData(input: {
  readonly files: readonly CodegraphFile[]
  readonly nodes: readonly CodegraphNode[]
  readonly edges: readonly CodegraphEdge[]
}): GraphData {
  const pathByID = new Map(input.files.map((file) => [file.id, file.path]))
  const fileIDByPath = new Map(input.files.map((file) => [file.path, file.id]))
  const nodesByFile = new Map<string, CodegraphNode[]>()
  const fileByNode = new Map<string, string>()
  for (const node of input.nodes) {
    fileByNode.set(node.id, node.fileID)
    const list = nodesByFile.get(node.fileID)
    if (list === undefined) nodesByFile.set(node.fileID, [node])
    else list.push(node)
  }
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key)
    if (list === undefined) map.set(key, [value])
    else list.push(value)
  }
  for (const edge of input.edges) {
    push(incoming, edge.toNodeID, edge.fromNodeID)
    push(outgoing, edge.fromNodeID, edge.toNodeID)
  }

  /** Nodes reached from `start`, grouped by hop, never leaving `ownFileID`. */
  const hops = (
    start: readonly CodegraphNode[],
    ownFileID: string,
    links: ReadonlyMap<string, readonly string[]>,
  ): { readonly perDepth: ReadonlyArray<Set<string>>; readonly files: ReadonlySet<string> } => {
    const seen = new Set<string>()
    const files = new Set<string>()
    const perDepth: Array<Set<string>> = []
    let frontier = start.map((node) => node.id)
    for (let depth = 0; depth < BFS_DEPTH; depth += 1) {
      const level = new Set<string>()
      for (const id of frontier) {
        for (const linked of links.get(id) ?? []) {
          if (seen.has(linked)) continue
          const fileID = fileByNode.get(linked)
          if (fileID === undefined || fileID === ownFileID) continue
          seen.add(linked)
          level.add(linked)
          const path = pathByID.get(fileID)
          if (path !== undefined) files.add(path)
          if (seen.size >= RESULT_LIMIT) break
        }
        if (seen.size >= RESULT_LIMIT) break
      }
      if (level.size === 0) break
      perDepth.push(level)
      frontier = [...level]
    }
    return { perDepth, files }
  }

  const cache = new Map<string, GraphFileInfo | undefined>()

  const fileAt = (path: string): GraphFileInfo | undefined => {
    const cached = cache.get(path)
    if (cached !== undefined || cache.has(path)) return cached
    const fileID = fileIDByPath.get(path)
    const nodes = fileID === undefined ? undefined : nodesByFile.get(fileID)
    if (fileID === undefined || nodes === undefined) {
      cache.set(path, undefined)
      return undefined
    }
    const imports = hops(nodes, fileID, outgoing)
    const dependents = hops(nodes, fileID, incoming)
    const direct = dependents.perDepth[0]?.size ?? 0
    const transitive = dependents.perDepth.slice(1).reduce((sum, level) => sum + level.size, 0)
    const ends = nodes.reduce((last, node) => Math.max(last, node.endLine), 0)
    const info: GraphFileInfo = {
      path,
      name: fileName(path),
      ...(ends > 0 ? { lines: ends } : {}),
      imports: [...imports.files].sort(),
      dependents: [...dependents.files].sort(),
      direct,
      transitive,
    }
    cache.set(path, info)
    return info
  }

  return { file: fileAt }
}
