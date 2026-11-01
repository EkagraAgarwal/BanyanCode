import { Effect } from "effect"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { ALL_EDGE_KINDS, CALLER_EDGE_KINDS, resolveFileByPath, resolveGraphTarget } from "./resolve.js"
import { countStaleFilesFor, isStale } from "./staleness.js"
import type { CodeFindInput, CodeFindOutput, GraphNode } from "./types.js"

/**
 * Symbol locator behind `banyancode.intel.codeFind` (parity row:
 * `POST /global/code-find`). The `code_find` *tool* belongs to the codegraph
 * workstream (`3a`); this module owns the RPC mirror of the v1 endpoint,
 * implemented over `CodegraphPort` so it shares resolution with the rest of
 * workstream 3c.
 */

const FILENAME_PATTERN =
  /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|sql|py|pyw|go|rs|java|kt|c|cpp|cc|cxx|h|hpp|hh|css|html|sh|ps1|vue|svelte)$/i

const looksLikeFilePath = (target: string): boolean => FILENAME_PATTERN.test(target) || /[\\/]/.test(target)

const matchesFilename = (path: string, target: string): boolean => {
  const normalized = path.replace(/\\/g, "/")
  if (normalized === target) return true
  return normalized.endsWith("/" + target) || normalized.endsWith(target)
}

const nodePaths = (port: CodegraphPort, nodes: readonly GraphNode[]): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.gen(function* () {
    const ids = [...new Set(nodes.map((node) => node.fileID))]
    if (ids.length === 0) return new Map()
    const files = yield* port.listFiles()
    const wanted = new Set(ids)
    return new Map(files.filter((file) => wanted.has(file.id)).map((file) => [file.id, file.path]))
  })

const withPaths = (
  port: CodegraphPort,
  output: CodeFindOutput,
): Effect.Effect<CodeFindOutput> =>
  Effect.gen(function* () {
    const paths = yield* nodePaths(port, output.matches.map((match) => match.node))
    return {
      ...output,
      matches: output.matches.map((match) => {
        const path = paths.get(match.node.fileID)
        return path ? { ...match, path } : match
      }),
    }
  })

export const computeCodeFind = (
  port: CodegraphPort,
  input: CodeFindInput,
): Effect.Effect<CodeFindOutput> =>
  Effect.gen(function* () {
    const limit = Math.max(1, Math.min(500, input.limit ?? 50))
    const meta = yield* port.meta()
    const graphMeta = meta
      ? {
          graphBuiltAt: meta.graphBuiltAt,
          graphVersion: meta.graphVersion,
          graphCoverage: meta.graphCoverage,
          totalFiles: meta.totalFiles,
          totalNodes: meta.totalNodes,
          totalEdges: meta.totalEdges,
        }
      : undefined
    const stale = isStale(meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined)

    const base = { intent: input.intent, ...(graphMeta ? { meta: graphMeta } : {}) } as const
    const empty = (diagnostic: CodeFindOutput["_diagnostic"], dispatchedTo: string): Effect.Effect<CodeFindOutput> =>
      Effect.succeed({ ...base, matches: [], files: [], dispatchedTo, ...(diagnostic ? { _diagnostic: diagnostic } : {}) })

    if (!input.target) return yield* empty("empty-target", "codegraph_query")

    const resolveTarget = Effect.gen(function* () {
      const resolution = yield* resolveGraphTarget(port, {
        target: input.target,
        limit,
        allowKeywordFallback: input.includeKeywordFallback !== false,
      })
      return resolution._tag === "Ok" ? resolution.value : undefined
    })

    if (input.intent === "find_file") {
      const allFiles = yield* port.listFiles()
      const pathHits = allFiles.filter((file) => matchesFilename(file.path, input.target)).slice(0, limit)
      const matches: Array<{ node: GraphNode; derivation: string }> = []

      const nodeMatches = (yield* port.searchByName({ name: input.target, limit })).filter(
        (node) => node.kind !== "file" && node.name === input.target,
      )
      for (const node of nodeMatches.slice(0, limit)) matches.push({ node, derivation: "name-exact" })

      if (pathHits.length > 0) {
        for (const file of pathHits) {
          const nodes = yield* port.nodesByFile(file.id)
          for (const node of nodes.slice(0, limit)) {
            if (matches.length >= limit) break
            matches.push({ node, derivation: "name-exact" })
          }
        }
      }

      return yield* withPaths(port, {
        ...base,
        matches: matches.slice(0, limit),
        files: pathHits.map((file) => ({ path: file.path })),
        dispatchedTo: pathHits.length > 0 ? "graph" : "glob",
        ...(matches.length === 0 && pathHits.length === 0 ? { _diagnostic: "target-not-resolved" as const } : {}),
      })
    }

    const resolved = yield* resolveTarget
    if (!resolved) {
      const dispatched =
        input.intent === "callers"
          ? "codegraph_callers"
          : input.intent === "dependents"
            ? "codegraph_dependents"
            : input.intent === "impact"
              ? "codegraph_impact"
              : "codegraph_query"
      return yield* empty("target-not-resolved", dispatched)
    }

    if (input.intent === "definition") {
      const matched = resolved.candidates.slice(0, limit).map((node) => ({ node, derivation: resolved.derivation }))
      const perFile = yield* countStaleFilesFor(port, matched.map((match) => match.node.fileID))
      return yield* withPaths(port, {
        ...base,
        matches: matched,
        files: [],
        dispatchedTo: "codegraph_query",
        resolvedNodeID: resolved.nodeID,
        resolvedDerivation: resolved.derivation,
        ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
        ...(perFile.stale || stale.stale ? { _diagnostic: "stale-graph" as const } : {}),
      })
    }

    if (input.intent === "callers") {
      const run = yield* bfs(port, {
        start: [resolved.nodeID],
        direction: "incoming",
        edgeKinds: CALLER_EDGE_KINDS,
        maxDepth: 1,
        resultLimit: limit,
      })
      const matches = run.results.map((result) => ({ node: result.node, derivation: resolved.derivation }))
      const perFile = yield* countStaleFilesFor(port, matches.map((match) => match.node.fileID))
      return yield* withPaths(port, {
        ...base,
        matches,
        files: [],
        dispatchedTo: "codegraph_callers",
        resolvedNodeID: resolved.nodeID,
        resolvedDerivation: resolved.derivation,
        ...(matches.length === 0 ? { _diagnostic: "no-edges-found" as const } : perFile.stale || stale.stale ? { _diagnostic: "stale-graph" as const } : {}),
        ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
      })
    }

    if (input.intent === "dependents") {
      const run = yield* bfs(port, {
        start: [resolved.nodeID],
        direction: "incoming",
        edgeKinds: ALL_EDGE_KINDS,
        maxDepth: 1,
        resultLimit: limit,
      })
      const matches = run.results.map((result) => ({ node: result.node, derivation: resolved.derivation }))
      const perFile = yield* countStaleFilesFor(port, matches.map((match) => match.node.fileID))
      return yield* withPaths(port, {
        ...base,
        matches,
        files: [],
        dispatchedTo: "codegraph_dependents",
        resolvedNodeID: resolved.nodeID,
        resolvedDerivation: resolved.derivation,
        ...(matches.length === 0 ? { _diagnostic: "no-edges-found" as const } : perFile.stale || stale.stale ? { _diagnostic: "stale-graph" as const } : {}),
        ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
      })
    }

    // impact: file-level aggregation when the target looks like a path.
    if (looksLikeFilePath(input.target)) {
      const file = yield* resolveFileByPath(port, input.target, meta?.indexedRoot as string | undefined)
      if (file) {
        const fileNodes = yield* port.nodesByFile(file.id)
        const run = yield* bfs(port, {
          start: fileNodes.map((node) => node.id),
          direction: "incoming",
          edgeKinds: ALL_EDGE_KINDS,
          maxDepth: 8,
          resultLimit: 500,
        })
        const matches = run.results.slice(0, limit).map((result) => ({ node: result.node, derivation: "name-exact" as const }))
        const perFile = yield* countStaleFilesFor(port, matches.map((match) => match.node.fileID))
        return yield* withPaths(port, {
          ...base,
          matches,
          files: [],
          dispatchedTo: "codegraph_impact",
          resolvedDerivation: "name-exact",
          ...(matches.length === 0 ? { _diagnostic: "no-edges-found" as const } : perFile.stale || stale.stale ? { _diagnostic: "stale-graph" as const } : {}),
          ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
        })
      }
    }

    const run = yield* bfs(port, {
      start: [resolved.nodeID],
      direction: "incoming",
      edgeKinds: ALL_EDGE_KINDS,
      maxDepth: 8,
      resultLimit: 500,
    })
    const matches = run.results.slice(0, limit).map((result) => ({ node: result.node, derivation: resolved.derivation }))
    const perFile = yield* countStaleFilesFor(port, matches.map((match) => match.node.fileID))
    return yield* withPaths(port, {
      ...base,
      matches,
      files: [],
      dispatchedTo: "codegraph_impact",
      resolvedNodeID: resolved.nodeID,
      resolvedDerivation: resolved.derivation,
      ...(matches.length === 0 ? { _diagnostic: "no-edges-found" as const } : perFile.stale || stale.stale ? { _diagnostic: "stale-graph" as const } : {}),
      ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
    })
  })
