import { GraphMeta, type CodegraphMeta } from "../banyancode/types"

export { GraphMeta as GraphMetaSchema }

export const staleInputFromMeta = (meta: CodegraphMeta | undefined) =>
  meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined

export const toGraphMeta = (meta: CodegraphMeta | undefined) =>
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

