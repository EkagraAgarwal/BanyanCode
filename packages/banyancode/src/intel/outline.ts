import { Effect } from "effect"
import { formatAugmentHeader } from "../gateway/formatter.js"
import { bfs } from "./bfs.js"
import type { CodegraphPort } from "./codegraph-port.js"
import { CALLER_EDGE_KINDS, resolveFileByPath } from "./resolve.js"
import type { GraphMeta, GraphNode, Outline } from "./types.js"
import { RepoFileSchema } from "./types.js"

/**
 * Cheap, bounded file views used by `repo`:
 *
 * - `outline` — every indexed symbol of one file (kind, name, line range) plus
 *   the same import/reference/caller/dependent summary a code read carries.
 * - `files` — glob matching over the indexed file paths.
 */

const MAX_OUTLINE_SYMBOLS = 500
const MAX_FILES = 2000
const TRANSITIVE_DEPTH = 3

const metaBlock = (meta: GraphMeta | undefined) =>
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

const MAIN_SYMBOL_PRIORITY: Readonly<Record<string, number>> = { class: 0, function: 1, method: 2, type: 3 }

const mainSymbol = (nodes: readonly GraphNode[]): GraphNode | undefined =>
  [...nodes].sort(
    (a, b) =>
      (MAIN_SYMBOL_PRIORITY[a.kind] ?? 99) - (MAIN_SYMBOL_PRIORITY[b.kind] ?? 99) || a.startLine - b.startLine,
  )[0]

export const computeOutline = (
  port: CodegraphPort,
  input: { path: string; limit?: number },
): Effect.Effect<Outline | undefined> =>
  Effect.gen(function* () {
    const meta = yield* port.meta()
    const file = yield* resolveFileByPath(port, input.path, meta?.indexedRoot)
    if (!file) return undefined

    const nodes = yield* port.nodesByFile(file.id)
    const limit = Math.max(1, Math.min(MAX_OUTLINE_SYMBOLS, input.limit ?? MAX_OUTLINE_SYMBOLS))
    const nodeIDs = new Set(nodes.map((node) => node.id))
    const [outgoing, incoming] = yield* Effect.all([port.edgesFrom([...nodeIDs]), port.edgesTo([...nodeIDs])])

    const imports = new Set(outgoing.filter((edge) => edge.kind === "imports").map((edge) => edge.toNodeID)).size
    const references = [...outgoing, ...incoming].filter((edge) => edge.kind === "references").length
    const callers = new Set(
      incoming
        .filter((edge) => CALLER_EDGE_KINDS.has(edge.kind) && !nodeIDs.has(edge.fromNodeID))
        .map((edge) => edge.fromNodeID),
    )
    const seen = new Set<string>([...nodeIDs, ...callers])
    const run = yield* bfs(port, {
      start: [...callers],
      direction: "incoming",
      edgeKinds: CALLER_EDGE_KINDS,
      maxDepth: TRANSITIVE_DEPTH,
      resultLimit: 500,
    })
    const dependents = run.results.filter((result) => !seen.has(result.node.id)).length
    const symbol = mainSymbol(nodes)

    const sorted = [...nodes].sort((a, b) => a.startLine - b.startLine)
    return {
      path: file.path,
      fileID: file.id,
      ...(file.language ? { language: file.language } : {}),
      header: formatAugmentHeader({
        symbol: symbol?.name ?? file.path,
        imports,
        references,
        callers: callers.size,
        dependents,
      }),
      imports,
      references,
      callers: callers.size,
      dependents,
      symbols: sorted.slice(0, limit).map((node) => ({
        kind: node.kind,
        name: node.name,
        startLine: node.startLine,
        endLine: node.endLine,
        ...(node.signature ? { signature: node.signature } : {}),
      })),
      truncated: sorted.length > limit,
      ...(meta ? { meta: metaBlock(meta) } : {}),
    }
  })

const escapeGlobChar = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const globToRegExp = (glob: string): RegExp => {
  let out = "^"
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1
        if (glob[index + 1] === "/") {
          index += 1
          out += "(?:.*/)?"
        } else out += ".*"
      } else out += "[^/]*"
      continue
    }
    if (char === "?") {
      out += "[^/]"
      continue
    }
    out += escapeGlobChar(char)
  }
  return new RegExp(out + "$")
}

const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "")

export type RepoFile = typeof RepoFileSchema.Type

export const computeRepoFiles = (
  port: CodegraphPort,
  input: { pattern: string; path?: string; limit?: number },
): Effect.Effect<{ files: RepoFile[]; total: number; truncated: boolean }> =>
  Effect.gen(function* () {
    const limit = Math.max(1, Math.min(MAX_FILES, input.limit ?? 200))
    const pattern = normalize(input.pattern.trim())
    if (!pattern) return { files: [], total: 0, truncated: false }
    const glob = globToRegExp(pattern)
    const prefix = input.path ? normalize(input.path.trim()).replace(/\/$/, "") : undefined
    const files = yield* port.listFiles()
    const hits = files
      .map((file) => ({ file, path: normalize(file.path) }))
      .filter(({ path }) => (prefix ? path === prefix || path.startsWith(prefix + "/") : true))
      .filter(({ path }) => {
        const relative = prefix ? path.slice(prefix.length + 1) : path
        const base = path.slice(path.lastIndexOf("/") + 1)
        return glob.test(path) || glob.test(relative) || (!pattern.includes("/") && glob.test(base))
      })
      .map(({ file, path }) => ({ path, ...(file.language ? { language: file.language } : {}) }))
      .sort((a, b) => a.path.localeCompare(b.path))
    return { files: hits.slice(0, limit), total: hits.length, truncated: hits.length > limit }
  })
