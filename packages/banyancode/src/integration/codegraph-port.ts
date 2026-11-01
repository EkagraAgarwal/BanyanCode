import { Effect } from "effect"
import type { Interface as CodegraphRepo } from "../codegraph/codegraph-repo.js"
import type { CodegraphMeta } from "../codegraph/types.js"
import type {
  CodegraphPort,
  DependentFilesInput,
  ListNodesInput,
  SearchByNameInput,
} from "../intel/codegraph-port.js"
import type { GraphFile, GraphMeta, GraphNode } from "../intel/types.js"

/**
 * Binds workstream 3c's read-only `CodegraphPort` to workstream 3a's real
 * repository. Every method projects the same `codegraph_*` rows; there is no
 * translation layer and no fallback to an empty graph for a real method.
 *
 * `server.ts` builds the repository once (`codegraph.makeServices`) and passes
 * it here, so the plugin never opens a second view of the same tables.
 */

const graphMeta = (meta: CodegraphMeta): GraphMeta => ({
  graphBuiltAt: meta.graphBuiltAt,
  graphVersion: meta.graphVersion,
  graphCoverage: meta.graphCoverage,
  totalFiles: meta.totalFiles,
  totalNodes: meta.totalNodes,
  totalEdges: meta.totalEdges,
  ...(meta.indexedRoot === undefined ? {} : { indexedRoot: meta.indexedRoot }),
})

const graphFile = (file: {
  readonly id: string
  readonly path: string
  readonly contentHash: string
  readonly language: string
  readonly indexedAt: number
  readonly sizeBytes?: number
  readonly mtimeMs?: number
}): GraphFile => ({
  id: file.id,
  path: file.path,
  contentHash: file.contentHash,
  language: file.language,
  indexedAt: file.indexedAt,
  ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
  ...(file.mtimeMs === undefined ? {} : { mtimeMs: file.mtimeMs }),
})

const graphNode = (node: {
  readonly id: string
  readonly fileID: string
  readonly kind: GraphNode["kind"]
  readonly name: string
  readonly signature?: string
  readonly startLine: number
  readonly endLine: number
  readonly code?: string
  readonly isEntrypoint?: number
  readonly inDegree?: number
}): GraphNode => ({
  id: node.id,
  fileID: node.fileID,
  kind: node.kind,
  name: node.name,
  ...(node.signature === undefined ? {} : { signature: node.signature }),
  startLine: node.startLine,
  endLine: node.endLine,
  ...(node.code === undefined ? {} : { code: node.code }),
  ...(node.isEntrypoint === undefined ? {} : { isEntrypoint: node.isEntrypoint }),
  ...(node.inDegree === undefined ? {} : { inDegree: node.inDegree }),
})

export const make = (repo: CodegraphRepo): CodegraphPort => ({
  meta: () => repo.getMeta().pipe(Effect.map((meta) => (meta === undefined ? undefined : graphMeta(meta)))),
  listFiles: () => repo.listAllFiles().pipe(Effect.map((files) => files.map(graphFile))),
  getFileByPath: (path) => repo.getFileByPath(path).pipe(Effect.map((file) => (file === undefined ? undefined : graphFile(file)))),
  fileByID: (id) => repo.getFile(id).pipe(Effect.map((file) => (file === undefined ? undefined : graphFile(file)))),
  nodesByFile: (fileID) => repo.listNodesByFile(fileID).pipe(Effect.map((nodes) => nodes.map(graphNode))),
  nodesByIDs: (ids) => repo.nodesByIDs([...ids]).pipe(Effect.map((nodes) => nodes.map(graphNode))),
  nodeByID: (id) => repo.nodeByID(id).pipe(Effect.map((node) => (node === undefined ? undefined : graphNode(node)))),
  edgesFrom: (nodeIDs) => repo.edgesFromBatch([...nodeIDs]),
  edgesTo: (nodeIDs) => repo.edgesToBatch([...nodeIDs]),
  searchByName: (input: SearchByNameInput) =>
    repo
      .searchNodesLight({
        name: input.name,
        limit: input.limit ?? 50,
        ...(input.fileID === undefined ? {} : { fileID: input.fileID }),
      })
      .pipe(Effect.map((nodes) => nodes.map(graphNode))),
  findByExactName: (input: SearchByNameInput) =>
    repo.queryNodes({ function: input.name }).pipe(
      Effect.map((nodes) =>
        nodes
          .filter((node) => input.fileID === undefined || node.fileID === input.fileID)
          .slice(0, input.limit ?? 50)
          .map(graphNode),
      ),
    ),
  searchFullText: (input) =>
    repo
      .ftsSearchNodes({ query: input.query, limit: input.limit ?? 50 })
      .pipe(Effect.map((nodes) => nodes.map(graphNode))),
  listNodes: (input?: ListNodesInput) =>
    repo
      .searchNodesLight({
        limit: input?.limit ?? 100_000,
        ...(input?.kind === undefined ? {} : { kind: input.kind }),
      })
      .pipe(Effect.map((nodes) => nodes.map(graphNode))),
  findByServiceTag: (tag) =>
    repo.findSymbolsByServiceTag(tag).pipe(Effect.map((nodes) => nodes.map(graphNode))),
  fileIDsByServiceName: (name) => repo.fileIDsByServiceName(name),
  dependentFiles: (input: DependentFilesInput) =>
    repo.dependentsOfFiles({ fileIDs: [...input.fileIDs], limit: input.limit ?? 100 }),
})

/**
 * Fail-closed port for the boot path where building the 3a services failed.
 * The intel/verify tools stay registered (and answer with empty results)
 * instead of preventing the whole plugin from loading.
 */
export const empty: CodegraphPort = {
  meta: () => Effect.succeed(undefined),
  listFiles: () => Effect.succeed([]),
  getFileByPath: () => Effect.succeed(undefined),
  fileByID: () => Effect.succeed(undefined),
  nodesByFile: () => Effect.succeed([]),
  nodesByIDs: () => Effect.succeed([]),
  nodeByID: () => Effect.succeed(undefined),
  edgesFrom: () => Effect.succeed([]),
  edgesTo: () => Effect.succeed([]),
  searchByName: () => Effect.succeed([]),
  findByExactName: () => Effect.succeed([]),
  searchFullText: () => Effect.succeed([]),
  listNodes: () => Effect.succeed([]),
  findByServiceTag: () => Effect.succeed([]),
  fileIDsByServiceName: () => Effect.succeed([]),
  dependentFiles: () => Effect.succeed([]),
}
