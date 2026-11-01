import { Effect } from "effect"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { isTestFilePath } from "./paths.js"
import { ALL_EDGE_KINDS, resolveGraphTarget } from "./resolve.js"
import type { Interface as Intelligence } from "./service.js"
import { countStaleFilesFor, isStale } from "./staleness.js"
import type { BlastRadiusInput, BlastRadiusOutput, GraphNode } from "./types.js"

/**
 * Count-only blast radius, ported from v1
 * `packages/core/src/tool/blast-radius.ts`.
 */

const BFS_MAX = 64

const score = (dependents: number, transitive: number): "low" | "medium" | "high" => {
  if (dependents === 0) return "low"
  const total = dependents + transitive
  if (total > 25 || dependents > 10) return "high"
  if (total > 6 || dependents > 3) return "medium"
  return "low"
}

export const computeBlastRadius = (
  deps: { readonly port: CodegraphPort; readonly intel: Intelligence },
  input: BlastRadiusInput,
): Effect.Effect<BlastRadiusOutput> =>
  Effect.gen(function* () {
    const resolution = yield* resolveGraphTarget(deps.port, { target: input.target })
    const resolved = resolution._tag === "Ok"

    const dependents: GraphNode[] = []
    const transitive: GraphNode[] = []
    if (resolved) {
      const run = yield* bfs(deps.port, {
        start: [resolution.value.nodeID],
        direction: "incoming",
        edgeKinds: ALL_EDGE_KINDS,
        maxDepth: 8,
        resultLimit: 500,
      })
      for (const result of run.results) {
        if (result.depth === 1) dependents.push(result.node)
        else transitive.push(result.node)
      }
    }

    const allFiles = yield* deps.port.listFiles()
    const filePathByID = new Map(allFiles.map((file) => [file.id, file.path]))

    const seenFileIDs = new Set<string>()
    for (const node of [...dependents, ...transitive]) seenFileIDs.add(node.fileID)

    const testFileIDs = new Set<string>()
    for (const id of seenFileIDs) {
      const filePath = filePathByID.get(id)
      if (filePath && isTestFilePath(filePath)) testFileIDs.add(id)
    }
    if (resolved) {
      const tests = yield* deps.intel.tests({ symbol: resolution.value.node.name })
      for (const test of tests.tests) testFileIDs.add(test.fileID)
    }

    const meta = yield* deps.port.meta()
    const stale = isStale(meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined)
    const perFileStale = yield* countStaleFilesFor(deps.port, [...seenFileIDs])
    const transitiveCount = input.maxDepth ? Math.min(transitive.length, BFS_MAX) : transitive.length

    return {
      directCallers: dependents.length,
      transitiveCallers: transitiveCount,
      filesAffected: seenFileIDs.size,
      testsToRun: testFileIDs.size,
      risk: resolved ? score(dependents.length, transitiveCount) : "unknown",
      resolved,
      ...(meta
        ? {
            meta: {
              graphBuiltAt: meta.graphBuiltAt,
              graphVersion: meta.graphVersion,
              graphCoverage: meta.graphCoverage,
              totalFiles: meta.totalFiles,
              totalNodes: meta.totalNodes,
              totalEdges: meta.totalEdges,
            },
          }
        : {}),
      ...(resolution._tag === "Ok" ? { resolutionDerivation: resolution.value.derivation } : {}),
      ...(stale.stale || perFileStale.stale ? { graphStale: true } : {}),
      ...(perFileStale.staleFiles > 0 ? { staleFiles: perFileStale.staleFiles } : {}),
    }
  })
