import type { CodegraphPort } from "../../src/intel/codegraph-port.js"
import type { GraphEdge, GraphFile, GraphMeta, GraphNode } from "../../src/intel/types.js"
import { Effect } from "effect"

/**
 * In-memory `CodegraphPort` fixture over rows shaped exactly like the
 * codegraph tables (`codegraph_files` / `codegraph_nodes` / `codegraph_edges`
 * projections). This is a fixture, not a mock of the system under test: the
 * intel pipeline (resolution, BFS, preflight classification) runs for real
 * over these rows.
 */

export interface FixtureRows {
  readonly files: readonly GraphFile[]
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly meta?: GraphMeta
  readonly serviceTags?: Readonly<Record<string, readonly string[]>>
}

export interface FixtureGraph {
  readonly port: CodegraphPort
  readonly rows: FixtureRows
}

const includesLower = (haystack: string | undefined, needle: string): boolean =>
  haystack !== undefined && haystack.toLowerCase().includes(needle.toLowerCase())

export const makeFixture = (rows: FixtureRows): FixtureGraph => {
  const files = [...rows.files]
  const nodes = [...rows.nodes]
  const edges = [...rows.edges]
  const nodeByID = new Map(nodes.map((node) => [node.id, node]))
  const fileByID = new Map(files.map((file) => [file.id, file]))
  const nodesByFileID = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const list = nodesByFileID.get(node.fileID)
    if (list) list.push(node)
    else nodesByFileID.set(node.fileID, [node])
  }

  const port: CodegraphPort = {
    meta: () => Effect.succeed(rows.meta),
    listFiles: () => Effect.succeed(files),
    getFileByPath: (path) => Effect.succeed(files.find((file) => file.path === path)),
    fileByID: (id) => Effect.succeed(fileByID.get(id)),
    nodesByFile: (fileID) => Effect.succeed(nodesByFileID.get(fileID) ?? []),
    nodesByIDs: (ids) => Effect.succeed(ids.flatMap((id) => (nodeByID.has(id) ? [nodeByID.get(id)!] : []))),
    nodeByID: (id) => Effect.succeed(nodeByID.get(id)),
    edgesFrom: (ids) => {
      const wanted = new Set(ids)
      return Effect.succeed(edges.filter((edge) => wanted.has(edge.fromNodeID)))
    },
    edgesTo: (ids) => {
      const wanted = new Set(ids)
      return Effect.succeed(edges.filter((edge) => wanted.has(edge.toNodeID)))
    },
    searchByName: (input) => {
      const limit = input.limit ?? 50
      const hits = nodes.filter(
        (node) => includesLower(node.name, input.name) && (input.fileID ? node.fileID === input.fileID : true),
      )
      return Effect.succeed(hits.slice(0, limit))
    },
    findByExactName: (input) => {
      const limit = input.limit ?? 50
      const hits = nodes.filter(
        (node) => node.name === input.name && (input.fileID ? node.fileID === input.fileID : true),
      )
      return Effect.succeed(hits.slice(0, limit))
    },
    searchFullText: (input) => {
      const limit = input.limit ?? 50
      const hits = nodes.filter(
        (node) =>
          includesLower(node.name, input.query) ||
          includesLower(node.signature, input.query) ||
          includesLower(node.code, input.query),
      )
      return Effect.succeed(hits.slice(0, limit))
    },
    listNodes: (input) => {
      const limit = input?.limit ?? 100_000
      const hits = input?.kind ? nodes.filter((node) => node.kind === input.kind) : nodes
      return Effect.succeed(hits.slice(0, limit))
    },
    findByServiceTag: (tag) => {
      const ids = rows.serviceTags?.[tag] ?? []
      return Effect.succeed(ids.flatMap((id) => (nodeByID.has(id) ? [nodeByID.get(id)!] : [])))
    },
    fileIDsByServiceName: (name) => {
      const ids = rows.serviceTags?.[name] ?? []
      return Effect.succeed(ids.flatMap((id) => (nodeByID.has(id) ? [nodeByID.get(id)!.fileID] : [])))
    },
    dependentFiles: (input) => {
      const fileNodes = new Set(
        input.fileIDs.flatMap((fileID) => (nodesByFileID.get(fileID) ?? []).map((node) => node.id)),
      )
      const out = new Set<string>()
      for (const edge of edges) {
        if (!fileNodes.has(edge.toNodeID)) continue
        const source = nodeByID.get(edge.fromNodeID)
        if (source) out.add(source.fileID)
      }
      return Effect.succeed([...out].slice(0, input.limit ?? 100))
    },
  }

  return { port, rows }
}
