import { Effect } from "effect"
import type { Interface as SearchInterface, SearchResult } from "../codegraph/search/search.js"
import type { Interface as StructuralQueriesInterface } from "../codegraph/structural-queries/structural-queries.js"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { ALL_EDGE_KINDS, CALLER_EDGE_KINDS, resolveFileByPath, resolveGraphTarget } from "./resolve.js"
import { countStaleFilesFor, isStale } from "./staleness.js"
import { globToRegExp } from "./outline.js"
import type { CodeFindInput, CodeFindIntent, CodeFindOutput, GraphMeta, GraphNode } from "./types.js"

/**
 * The one symbol locator behind `code_find` (tool) and
 * `banyancode.intel.codeFind` (RPC). Intents route to the graph primitive that
 * answers them; no intent re-implements resolution or traversal.
 *
 * `search` and `symbols` intents are served by `computeCodeFind` when the
 * caller passes the codegraph search service; `implementations` / `overrides`
 * need the structural-query service. Both are optional so the RPC handler and
 * the in-memory test ports keep working without them.
 */

export interface CodeFindGraph {
  readonly search: Pick<SearchInterface, "search">
  readonly structural: Pick<
    StructuralQueriesInterface,
    "findImplementations" | "findOverrides" | "findRecursiveFunctions" | "findAsyncFunctions" | "findHTTPRoutes"
  >
}

const FILENAME_PATTERN =
  /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|sql|py|pyw|go|rs|java|kt|c|cpp|cc|cxx|h|hpp|hh|css|html|sh|ps1|vue|svelte)$/i

const FUZZY_MODES = ["BM25", "Fuzzy", "Prefix", "CamelCase", "snake_case", "Qualified"] as const

const REFERENCES_EDGE_KINDS = new Set(["references" as const])

const clampLimit = (value: number | undefined, fallback = 50): number =>
  Math.max(1, Math.min(500, value ?? fallback))

export const looksLikeFilePath = (target: string): boolean => FILENAME_PATTERN.test(target) || /[\\/]/.test(target)

const matchesFilename = (path: string, target: string): boolean => {
  const normalized = path.replace(/\\/g, "/")
  if (normalized === target) return true
  return normalized.endsWith("/" + target) || normalized.endsWith(target)
}

const baseMeta = (meta: GraphMeta | undefined) =>
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

const pathsFor = (port: CodegraphPort, nodes: readonly GraphNode[]): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.gen(function* () {
    const ids = [...new Set(nodes.map((node) => node.fileID))]
    if (ids.length === 0) return new Map()
    const files = yield* port.listFiles()
    const wanted = new Set(ids)
    return new Map(files.filter((file) => wanted.has(file.id)).map((file) => [file.id, file.path]))
  })

const attachPaths = (
  port: CodegraphPort,
  matches: ReadonlyArray<{ node: GraphNode; derivation: string; path?: string }>,
): Effect.Effect<ReadonlyArray<{ node: GraphNode; derivation: string; path?: string }>> =>
  Effect.gen(function* () {
    const paths = yield* pathsFor(port, matches.map((match) => match.node))
    return matches.map((match) => {
      const path = paths.get(match.node.fileID)
      return path ? { ...match, path } : match
    })
  })

/**
 * Direct + transitive incoming dependents for one resolved node, limited to
 * depth 8 / 500 rows like `CodegraphAnalyzer.impact`.
 */
export const computeImpactEdges = (
  port: CodegraphPort,
  input: { target?: string; nodeID?: string; maxDepth?: number; limit?: number },
): Effect.Effect<
  {
    dependents: GraphNode[]
    transitive: GraphNode[]
    meta?: ReturnType<typeof baseMeta>
    resolved?: boolean
    resolvedNodeID?: string
    resolutionDerivation?: string
  }
> =>
  Effect.gen(function* () {
    const limit = clampLimit(input.limit, 500)
    const meta = yield* port.meta()
    const resolved = input.nodeID
      ? yield* port.nodeByID(input.nodeID).pipe(Effect.map((node) => (node ? { nodeID: node.id, node, derivation: "name-exact" } : undefined)))
      : input.target
        ? yield* resolveGraphTarget(port, { target: input.target }).pipe(
            Effect.map((result) =>
              result._tag === "Ok"
                ? { nodeID: result.value.nodeID, node: result.value.node, derivation: result.value.derivation }
                : undefined,
            ),
          )
        : undefined
    if (!resolved) return { dependents: [], transitive: [], ...(meta ? { meta: baseMeta(meta) } : {}), resolved: false }
    const run = yield* bfs(port, {
      start: [resolved.nodeID],
      direction: "incoming",
      edgeKinds: ALL_EDGE_KINDS,
      maxDepth: input.maxDepth ?? 8,
      resultLimit: 500,
    })
    const dependents: GraphNode[] = []
    const transitive: GraphNode[] = []
    for (const result of run.results) {
      if (dependents.length + transitive.length >= limit) break
      if (result.depth === 1) dependents.push(result.node)
      else transitive.push(result.node)
    }
    return {
      dependents,
      transitive,
      ...(meta ? { meta: baseMeta(meta) } : {}),
      resolved: true,
      resolvedNodeID: resolved.nodeID,
      resolutionDerivation: resolved.derivation,
    }
  })

type MatchEntry = { node: GraphNode; derivation: string; path?: string }

export const computeCodeFind = (
  port: CodegraphPort,
  input: CodeFindInput,
  graph?: CodeFindGraph,
): Effect.Effect<CodeFindOutput> =>
  Effect.gen(function* () {
    const limit = clampLimit(input.limit)
    const meta = yield* port.meta()
    const graphMeta = baseMeta(meta)
    const stale = isStale(meta ? { graphBuiltAt: meta.graphBuiltAt, graphCoverage: meta.graphCoverage } : undefined)
    const base = { intent: input.intent, ...(graphMeta ? { meta: graphMeta } : {}) } as const
    // grep's `include` narrows a content search to a path glob; the graph answer
    // is filtered the same way so a scoped grep keeps its scope after a swap.
    const include = input.include?.trim()
    const includeGlob = include === undefined || include === "" ? undefined : globToRegExp(include.replaceAll("\\", "/"))
    const inScope = (path: string | undefined): boolean => {
      if (includeGlob === undefined) return true
      if (path === undefined) return false
      const normalized = path.replaceAll("\\", "/")
      const base = normalized.slice(normalized.lastIndexOf("/") + 1)
      return includeGlob.test(normalized) || (!include!.includes("/") && includeGlob.test(base))
    }

    const finish = (matches: MatchEntry[], extra: Partial<CodeFindOutput>) =>
      Effect.gen(function* () {
        const perFile = yield* countStaleFilesFor(
          port,
          matches.map((match) => match.node.fileID),
        )
        const attached = (yield* attachPaths(port, matches)).filter((match) => inScope(match.path))
        const diagnostic =
          extra._diagnostic !== undefined
            ? extra._diagnostic
            : attached.length === 0
              ? ("target-not-resolved" as const)
              : stale.stale || perFile.stale
                ? ("stale-graph" as const)
                : undefined
        return {
          ...base,
          matches: attached,
          files: [],
          ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...extra,
        } as CodeFindOutput
      })

    const empty = (diagnostic: CodeFindOutput["_diagnostic"], dispatchedTo = input.intent) =>
      Effect.succeed({
        ...base,
        matches: [],
        files: [],
        dispatchedTo,
        ...(diagnostic ? { _diagnostic: diagnostic } : {}),
      }) as Effect.Effect<CodeFindOutput>

    const target = input.target.trim()
    if (!target) return yield* empty("empty-target")

    // `path` narrows resolution to one file (the old raw-query file filter).
    const file = input.path ? yield* resolveFileByPath(port, input.path, meta?.indexedRoot) : undefined
    const resolveTarget = Effect.gen(function* () {
      const result = yield* resolveGraphTarget(port, {
        target,
        limit,
        allowKeywordFallback: input.includeKeywordFallback !== false,
        ...(file ? { fileID: file.id } : {}),
      })
      return result._tag === "Ok" ? result.value : undefined
    })

    switch (input.intent) {
      case "definition": {
        const resolved = yield* resolveTarget
        if (!resolved) return yield* empty("target-not-resolved")
        return yield* finish(
          resolved.candidates.slice(0, limit).map((node) => ({ node, derivation: resolved.derivation })),
          {
            dispatchedTo: input.intent,
            resolvedNodeID: resolved.nodeID,
            resolvedDerivation: resolved.derivation,
          },
        )
      }
      case "usages": {
        const resolved = yield* resolveTarget
        if (!resolved) return yield* empty("target-not-resolved")
        // The definition plus every incoming call/reference: what a text search
        // for one identifier is normally read for.
        const run = yield* bfs(port, {
          start: [resolved.nodeID],
          direction: "incoming",
          edgeKinds: ALL_EDGE_KINDS,
          maxDepth: 1,
          resultLimit: limit,
        })
        const definitions = resolved.candidates.slice(0, limit)
        const seen = new Set(definitions.map((node) => node.id))
        const usages = run.results.map((result) => result.node).filter((node) => !seen.has(node.id))
        return yield* finish(
          [...definitions, ...usages].slice(0, limit).map((node) => ({ node, derivation: resolved.derivation })),
          {
            dispatchedTo: input.intent,
            resolvedNodeID: resolved.nodeID,
            resolvedDerivation: resolved.derivation,
            ...(usages.length === 0 ? { _diagnostic: "no-edges-found" as const } : {}),
          },
        )
      }
      case "impact": {
        // Transitive dependents of a symbol, or of every symbol in a file when
        // the target is a path. The MCP `banyan_code_find` tool exposes this.
        const targetFile = looksLikeFilePath(target) ? yield* resolveFileByPath(port, target, meta?.indexedRoot) : undefined
        const resolved = targetFile ? undefined : yield* resolveTarget
        if (!targetFile && !resolved) return yield* empty("target-not-resolved")
        const start = targetFile
          ? (yield* port.nodesByFile(targetFile.id)).map((node) => node.id)
          : [resolved?.nodeID ?? ""]
        const run = yield* bfs(port, {
          start,
          direction: "incoming",
          edgeKinds: ALL_EDGE_KINDS,
          maxDepth: 8,
          resultLimit: 500,
        })
        const derivation = resolved?.derivation ?? ("name-exact" as const)
        return yield* finish(
          run.results.slice(0, limit).map((result) => ({ node: result.node, derivation })),
          {
            dispatchedTo: input.intent,
            ...(resolved ? { resolvedNodeID: resolved.nodeID } : {}),
            resolvedDerivation: derivation,
            ...(run.results.length === 0 ? { _diagnostic: "no-edges-found" as const } : {}),
          },
        )
      }
      case "callers":
      case "references":
      case "dependents": {
        const resolved = yield* resolveTarget
        if (!resolved) return yield* empty("target-not-resolved")
        const edgeKinds =
          input.intent === "callers"
            ? CALLER_EDGE_KINDS
            : input.intent === "references"
              ? REFERENCES_EDGE_KINDS
              : ALL_EDGE_KINDS
        const run = yield* bfs(port, {
          start: [resolved.nodeID],
          direction: "incoming",
          edgeKinds,
          maxDepth: 1,
          resultLimit: limit,
        })
        return yield* finish(
          run.results.map((result) => ({ node: result.node, derivation: resolved.derivation })),
          {
            dispatchedTo: input.intent,
            resolvedNodeID: resolved.nodeID,
            resolvedDerivation: resolved.derivation,
            ...(run.results.length === 0 ? { _diagnostic: "no-edges-found" as const } : {}),
          },
        )
      }
      case "implementations":
      case "overrides": {
        const structural = graph?.structural
        if (!structural) return yield* empty("target-not-resolved")
        const filter = input.path
          ? {
              file: input.path,
            }
          : {}
        const nodes =
          input.intent === "implementations"
            ? yield* structural.findImplementations({ interfaceName: target, ...filter })
            : yield* structural.findOverrides({ methodName: target, ...filter })
        return yield* finish(
          nodes.slice(0, limit).map((node) => ({ node, derivation: "name-exact" as const })),
          { dispatchedTo: input.intent },
        )
      }
      case "symbols": {
        const resolved = yield* resolveTarget
        const nodes = resolved
          ? resolved.candidates
          : yield* port.searchByName({ name: target, limit })
        return yield* finish(
          nodes.slice(0, limit).map((node) => ({ node, derivation: resolved?.derivation ?? "name-like" })),
          { dispatchedTo: input.intent },
        )
      }
      case "search": {
        const search = graph?.search
        if (!search) return yield* empty("target-not-resolved")
        const results = yield* search.search(target, { modes: [...FUZZY_MODES], limit })
        return {
          ...base,
          matches: [],
          files: [],
          results: [...results],
          dispatchedTo: input.intent,
        } as CodeFindOutput
      }
      case "find_file": {
        const allFiles = yield* port.listFiles()
        const pathHits = allFiles.filter((file) => matchesFilename(file.path, target)).slice(0, limit)
        const matches: MatchEntry[] = []

        const nodeMatches = (yield* port.searchByName({ name: target, limit })).filter(
          (node) => node.kind !== "file" && node.name === target,
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

        const output = yield* finish(matches.slice(0, limit), {
          files: pathHits.map((file) => ({ path: file.path })),
          dispatchedTo: pathHits.length > 0 ? "graph" : "glob",
          ...(matches.length === 0 && pathHits.length === 0 ? { _diagnostic: "target-not-resolved" as const } : {}),
        })
        return output
      }
      default:
        return yield* empty("target-not-resolved")
    }
  })

const MAX_RENDERED = 25

const renderNode = (node: GraphNode, path: string | undefined): string => {
  const signature = node.signature ? ` ${node.signature.length > 80 ? node.signature.slice(0, 79) + "\u2026" : node.signature}` : ""
  const location = path ? `${path}:${node.startLine}-${node.endLine}` : `${node.fileID}:${node.startLine}-${node.endLine}`
  return `${node.kind} ${node.name} (${location})${signature}`
}

const HEADERS: Readonly<Record<CodeFindIntent, string>> = {
  definition: "Matches",
  usages: "Usages",
  callers: "Callers",
  references: "References",
  dependents: "Dependents",
  impact: "Transitive dependents",
  implementations: "Implementations",
  overrides: "Overrides",
  symbols: "Symbols",
  search: "Search results",
  find_file: "Matches",
}

/** Model-facing text: the same per-intent headers the replaced tools used. */
export const renderCodeFind = (output: CodeFindOutput): string => {
  const fuzzy =
    output.resolvedDerivation && ["code-substring", "name-like", "fts-bm25"].includes(output.resolvedDerivation)
      ? output.resolvedDerivation
      : undefined
  const headerParts = [
    fuzzy ? `FALLBACK MATCH (derivation=${fuzzy}) -- verify before treating as the exact symbol` : null,
    `intent=${output.intent}`,
    `dispatched=${output.dispatchedTo ?? "n/a"}`,
    `matches=${output.matches.length}`,
    `files=${output.files.length}`,
  ]
  if (output.resolvedNodeID) headerParts.push(`resolved=${output.resolvedNodeID}`)
  if (output.resolvedDerivation) headerParts.push(`derivation=${output.resolvedDerivation}`)
  if (output._diagnostic) headerParts.push(`diagnostic=${output._diagnostic}`)
  const header = headerParts.filter((part): part is string => part !== null).join(" ")

  const results = output.results
  if (results !== undefined) {
    const visible = results.slice(0, MAX_RENDERED)
    const lines = visible.map((result) => `[score=${result.score.toFixed(2)}] ${renderNode(result.node, undefined)}`)
    const remaining = results.length - visible.length
    const block =
      results.length === 0
        ? "Search results: none."
        : `Search results (${results.length}):\n${lines.join("\n")}${remaining > 0 ? `\n... and ${remaining} more.` : ""}`
    return `${header}\n\n${block}`
  }

  const visible = output.matches.slice(0, MAX_RENDERED)
  const heading = HEADERS[output.intent as CodeFindIntent] ?? "Matches"
  const remaining = output.matches.length - visible.length
  const matchesBlock =
    output.matches.length === 0
      ? `${heading}: none.`
      : `${heading} (${output.matches.length}):\n${visible.map((match) => renderNode(match.node, match.path)).join("\n")}${
          remaining > 0 ? `\n... and ${remaining} more (see structured output for the full list).` : ""
        }`
  const showFiles = output.intent === "find_file" || output.files.length > 0
  const filesBlock = !showFiles
    ? ""
    : output.files.length > 0
      ? `Files (${output.files.length}):\n${output.files.map((file) => `  ${file.path}`).join("\n")}`
      : "Files: none."
  return filesBlock ? `${header}\n\n${matchesBlock}\n\n${filesBlock}` : `${header}\n\n${matchesBlock}`
}

export type { SearchResult }
