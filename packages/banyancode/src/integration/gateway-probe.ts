import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { Interface as CodegraphRepo } from "../codegraph/codegraph-repo.js"
import type { CodegraphFile, CodegraphNode } from "../codegraph/types.js"
import { formatAugmentHeader } from "../gateway/formatter.js"
import { identifierQuery, isCodePath } from "../gateway/routing.js"
import type { GatewayProbe, ProbeInput, ProbeResult } from "../gateway/types.js"
import { UNPROBED } from "../gateway/types.js"
import { buildPathCandidates } from "../intel/resolve.js"
import { isStale } from "../intel/staleness.js"
import type { Storage } from "../storage/index.js"

/**
 * Binds the gateway's probe seam to the real graph.
 *
 * Every lookup is bounded and indexed: one `codegraph_meta` row, one
 * `codegraph_files.path = ?` per path candidate (UNIQUE index), a bounded
 * `name LIKE` with an exact JS filter, and one `LIKE ... LIMIT 1` per glob.
 * `fileForPath` never lists the file table. A failing or missing graph yields
 * `UNPROBED`, which always falls back to the original tool.
 */

export interface ProbeOptions {
  /** Needed for the glob match probe; without it a built graph counts as non-empty. */
  readonly storage?: Storage.Interface
  /** Files above this are treated as large without hashing (bounded probe cost). */
  readonly maxHashBytes?: number
}

const DEFAULT_MAX_HASH_BYTES = 256 * 1024

const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "")

/**
 * The graph stores paths relative to the indexed root on POSIX and absolute
 * paths with backslashes on Windows, so both separator spellings of each
 * candidate are tried. Bounded: at most two point lookups per candidate.
 */
const findFile = (
  repo: CodegraphRepo,
  target: string,
  indexedRoot: string | undefined,
): Effect.Effect<CodegraphFile | undefined, never, never> =>
  Effect.gen(function* () {
    if (target.trim() === "") return undefined
    for (const candidate of buildPathCandidates(target, indexedRoot)) {
      for (const spelling of [candidate, candidate.replaceAll("/", "\\")]) {
        const file = yield* repo.getFileByPath(spelling)
        if (file !== undefined) return file
      }
    }
    return undefined
  })

const MAIN_SYMBOL_PRIORITY: Readonly<Record<string, number>> = {
  class: 0,
  function: 1,
  method: 2,
  type: 3,
}

const mainSymbol = (nodes: readonly CodegraphNode[]): CodegraphNode | undefined =>
  [...nodes].sort(
    (a, b) =>
      (MAIN_SYMBOL_PRIORITY[a.kind] ?? 99) - (MAIN_SYMBOL_PRIORITY[b.kind] ?? 99) || a.startLine - b.startLine,
  )[0]

const CALLER_KINDS = new Set(["calls", "references"])

/** Depth > 1 incoming call/reference dependents, bounded so a Read stays cheap. */
const transitiveDependents = (
  repo: CodegraphRepo,
  depthOne: readonly string[],
  seen: Set<string>,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    if (depthOne.length === 0) return 0
    let count = 0
    let frontier = [...depthOne]
    for (let depth = 0; depth < 3 && frontier.length > 0 && count < 500; depth += 1) {
      const edges = yield* repo.edgesToBatch(frontier)
      const next = new Set<string>()
      for (const edge of edges) {
        if (!CALLER_KINDS.has(edge.kind)) continue
        if (seen.has(edge.fromNodeID)) continue
        seen.add(edge.fromNodeID)
        next.add(edge.fromNodeID)
        count += 1
      }
      frontier = [...next]
    }
    return count
  })

/**
 * Glob patterns become one bounded SQL `LIKE` per spelling; a miss means the
 * graph has no candidate. Indexed paths are stored relative on POSIX and
 * absolute with backslashes on Windows, so both separator spellings are tried.
 */
const globLikes = (pattern: string): string[] => {
  const cleaned = normalize(pattern.trim())
  const wildcard = cleaned.search(/[*?]/)
  const likes: string[] = []
  if (wildcard > 0) {
    const prefix = cleaned.slice(0, wildcard)
    const cut = prefix.lastIndexOf("/")
    // `src/**/*.ts` -> `src/`; `src/a*` -> `src/`
    const base = (cut >= 0 ? prefix.slice(0, cut + 1) : prefix).replace(/[%_]/g, "")
    if (base !== "") likes.push(`%${base}%`, `%${base.replaceAll("/", "\\")}%`)
  }
  const extension = cleaned.includes(".") ? cleaned.slice(cleaned.lastIndexOf(".")) : ""
  if (extension !== "" && !/[*?]/.test(extension)) likes.push(`%${extension}`)
  return likes.length === 0 ? ["%"] : likes
}

const countMatch = (storage: Storage.Interface, pattern: string): Effect.Effect<number> =>
  storage
    .query<{ present: number }>(
      `SELECT 1 AS present FROM codegraph_files WHERE ${globLikes(pattern)
        .map(() => "path LIKE ?")
        .join(" OR ")} LIMIT 1`,
      globLikes(pattern),
    )
    .pipe(
      Effect.map((rows) => rows.length),
      Effect.catchCause(() => Effect.succeed(1)),
    )

interface FileFacts {
  readonly indexed: boolean
  readonly lines?: number
  readonly bytes?: number
  readonly stale: boolean
}

/**
 * Indexed file facts from the graph row plus one bounded disk read: the hash
 * decides staleness exactly for files up to `maxHashBytes`, the mtime decides
 * it otherwise.
 */
const fileFacts = (
  repo: CodegraphRepo,
  target: string,
  indexedRoot: string | undefined,
  maxHashBytes: number,
): Effect.Effect<FileFacts> =>
  Effect.gen(function* () {
    const file = yield* findFile(repo, target, indexedRoot)
    if (file === undefined) return { indexed: false, stale: false }

    const absolute = path.isAbsolute(target) ? target : path.join(indexedRoot ?? "", target)
    const bytes = file.sizeBytes ?? 0
    if (bytes > maxHashBytes) {
      const info = yield* Effect.promise(() => stat(absolute)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const stale = info === undefined ? true : Math.abs(info.mtimeMs - (file.mtimeMs ?? 0)) > 2
      return { indexed: true, bytes, stale, lines: Number.MAX_SAFE_INTEGER }
    }

    const content = yield* Effect.tryPromise({
      try: () => readFile(absolute, "utf8"),
      catch: () => new Error("unreadable"),
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (content === undefined) return { indexed: true, bytes, stale: true }
    const lines = content.length === 0 ? 0 : content.split("\n").length
    if (typeof file.contentHash !== "string" || file.contentHash === "") return { indexed: true, bytes, stale: true, lines }
    const hash = createHash("sha256").update(content).digest("hex")
    return { indexed: true, bytes, stale: hash !== file.contentHash, lines }
  })

export const make = (repo: CodegraphRepo, options: ProbeOptions = {}): GatewayProbe => {
  const maxHashBytes = options.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES

  const fileForPath = (target: string) =>
    Effect.gen(function* () {
      if (target.trim() === "") return undefined
      const meta = yield* repo.getMeta()
      return yield* findFile(repo, target, meta?.indexedRoot)
    })

  const probe = (input: ProbeInput): Effect.Effect<ProbeResult, never, never> =>
    Effect.gen(function* () {
      const meta = yield* repo.getMeta()
      if (meta === undefined) return UNPROBED
      const stale = isStale(meta).stale

      if (input.tool === "read") {
        const target = typeof input.arguments.path === "string" ? input.arguments.path : input.arguments.filePath
        if (typeof target !== "string") return UNPROBED
        const facts = yield* fileFacts(repo, target, meta.indexedRoot, maxHashBytes)
        return {
          graphBuilt: true,
          stale,
          indexed: facts.indexed,
          fileStale: facts.stale,
          ...(facts.lines === undefined ? {} : { lines: facts.lines }),
          ...(facts.bytes === undefined ? {} : { bytes: facts.bytes }),
        }
      }

      if (input.tool === "grep") {
        const pattern = typeof input.arguments.pattern === "string" ? input.arguments.pattern : ""
        const identifier = identifierQuery(pattern)
        if (identifier === undefined) return { graphBuilt: true, stale, symbolHits: 0 }
        const leaf = identifier.includes(".") ? identifier.slice(identifier.lastIndexOf(".") + 1) : identifier
        const nodes = yield* repo.searchNodesLight({ name: leaf, limit: 20 })
        const hits = nodes.filter(
          (node) => node.kind !== "file" && (node.name === identifier || node.name === leaf),
        ).length
        return { graphBuilt: true, stale, symbolHits: hits }
      }

      const pattern = typeof input.arguments.pattern === "string" ? input.arguments.pattern : ""
      const matchCount = options.storage === undefined ? 1 : yield* countMatch(options.storage, pattern)
      return { graphBuilt: true, stale, matchCount }
    }).pipe(Effect.catchCause(() => Effect.succeed(UNPROBED)))

  return {
    probe,
    augmentRead: (input) =>
      Effect.gen(function* () {
        if (!isCodePath(input.path)) return undefined
        const file = yield* fileForPath(input.path)
        if (file === undefined) return undefined
        const nodes = yield* repo.listNodesByFile(file.id)
        const symbol = mainSymbol(nodes)
        if (symbol === undefined) return undefined
        const nodeIDs = new Set(nodes.map((node) => node.id))
        const [outgoing, incoming] = yield* Effect.all([repo.edgesFromBatch([...nodeIDs]), repo.edgesToBatch([...nodeIDs])])
        const importTargets = new Set(outgoing.filter((edge) => edge.kind === "imports").map((edge) => edge.toNodeID))
        const targetNames = new Set(
          (importTargets.size === 0 ? [] : yield* repo.nodesByIDs([...importTargets])).map((node) => node.name),
        )
        const references = [...outgoing, ...incoming].filter((edge) => edge.kind === "references").length
        const callers = new Set(
          incoming
            .filter((edge) => CALLER_KINDS.has(edge.kind) && !nodeIDs.has(edge.fromNodeID))
            .map((edge) => edge.fromNodeID),
        )
        const seen = new Set<string>([...nodeIDs, ...callers])
        const dependents = yield* transitiveDependents(repo, [...callers], seen)
        return formatAugmentHeader({
          symbol: symbol.name,
          imports: targetNames.size,
          references,
          callers: callers.size,
          dependents,
        })
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
  }
}
