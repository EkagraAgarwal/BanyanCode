import { Effect } from "effect"
import type { Interface as CodegraphRepo } from "../codegraph/codegraph-repo.js"
import type { CodegraphNode } from "../codegraph/types.js"
import { formatAugmentHeader } from "../gateway/formatter.js"
import type { CodegraphQuery, GatewayRewrite, RepositoryOperation } from "../gateway/types.js"

/**
 * Binds the gateway's `CodegraphQuery` seam to the real 3a repository.
 *
 * `route` rewrites an INTELLIGENCE decision onto a registered codegraph/intel
 * tool call. The rewrite is issued only when the graph has a meta row (an
 * unbuilt graph falls back to the original grep/read, which is authoritative
 * for text) and only when the target tool was actually registered — a failed
 * workstream registration must not turn a normal tool call into "unknown
 * tool".
 *
 * `augmentRead` renders the same compact `Symbol | Imports | References |
 * Callers | Dependents` header v1 prepended to code-file reads, computed from
 * `codegraph_*` rows rather than an in-memory query result.
 */

export interface QueryOptions {
  /** Tool ids currently registered with the host. Omit to allow every rewrite. */
  readonly availableTools?: ReadonlySet<string>
}

const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "")

const suffixMatch = (requested: string, candidate: string): boolean => {
  const a = normalize(requested)
  const b = normalize(candidate)
  if (a === b) return true
  return a.endsWith("/" + b) || b.endsWith("/" + a)
}

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

export const make = (repo: CodegraphRepo, options: QueryOptions = {}): CodegraphQuery => {
  const available = options.availableTools
  const can = (tool: string) => available === undefined || available.has(tool)

  const rewrite = (tool: string, input: Record<string, unknown>): GatewayRewrite | undefined =>
    can(tool) ? { tool, input } : undefined

  const routeOperation = (operation: RepositoryOperation): GatewayRewrite | undefined => {
    switch (operation.kind) {
      case "symbol":
        return rewrite("code_find", { intent: "definition", target: operation.query, includeKeywordFallback: true })
      case "relationship":
        switch (operation.relation) {
          case "callers":
          case "references":
            return rewrite("codegraph_callers", { function: operation.target, limit: 200 })
          case "dependents":
            return rewrite("codegraph_dependents", { function: operation.target, limit: 200 })
          case "implementations":
          case "extensions":
            return rewrite("codegraph_find_implementations", { interfaceName: operation.target })
          case "imports":
            return undefined
        }
        return undefined
      case "architecture":
        return rewrite("repository_explain", { symbol: operation.query })
      case "ownership":
        return rewrite("repository_ownership", { path: operation.query })
      case "structural":
        return rewrite("codegraph_search", { query: operation.query })
      case "content":
      case "text_search":
      case "file_discovery":
        return undefined
    }
  }

  const fileForPath = (path: string) =>
    Effect.gen(function* () {
      if (path.trim() === "") return undefined
      const exact = yield* repo.getFileByPath(normalize(path))
      if (exact !== undefined) return exact
      const files = yield* repo.listAllFiles()
      return files.find((file) => suffixMatch(path, file.path))
    })

  return {
    route: (input) =>
      Effect.gen(function* () {
        const meta = yield* repo.getMeta()
        if (meta === undefined) return undefined
        return routeOperation(input.operation)
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
    augmentRead: (input) =>
      Effect.gen(function* () {
        const file = yield* fileForPath(input.path)
        if (file === undefined) return undefined
        const nodes = yield* repo.listNodesByFile(file.id)
        const symbol = mainSymbol(nodes)
        if (symbol === undefined) return undefined
        const nodeIDs = new Set(nodes.map((node) => node.id))
        const [outgoing, incoming] = yield* Effect.all([
          repo.edgesFromBatch([...nodeIDs]),
          repo.edgesToBatch([...nodeIDs]),
        ])
        const importTargets = new Set(
          outgoing.filter((edge) => edge.kind === "imports").map((edge) => edge.toNodeID),
        )
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
