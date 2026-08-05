export * as CodegraphAnalyzer from "./codegraph-analyzer"

import { Context, Effect, Layer, Schema } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import { bfsPure } from "./repository-intelligence/bfs"
import { resolveGraphTargetPure } from "./symbol-resolver"
import type { CodegraphEdgeKind, CodegraphNode } from "./types"

export class SymbolNotFoundError extends Schema.TaggedErrorClass<SymbolNotFoundError>()("Banyan/SymbolNotFoundError", {
  symbol: Schema.String,
}) {}

export interface Interface {
  readonly callers: (input: { nodeID?: string; function?: string }) => Effect.Effect<CodegraphNode[], SymbolNotFoundError>
  readonly dependents: (input: { nodeID?: string; function?: string }) => Effect.Effect<CodegraphNode[], SymbolNotFoundError>
  readonly impact: (input: { nodeID?: string; function?: string }) => Effect.Effect<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }, SymbolNotFoundError>
  readonly walkTransitive: (input: { nodeID: string; direction: "upstream" | "downstream"; maxDepth?: number }) => Effect.Effect<CodegraphNode[]>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphAnalyzer") {}

// Phase 3 (codegraph-tools-v2 P2): every traversal below runs through
// `bfsPure` — the same batched frontier-swap primitive as
// repository-intelligence — instead of per-node `edgesTo`/`edgesFrom` (N+1).
// Edge queries are now O(depth): one `edgesToBatch`/`edgesFromBatch` per
// frontier, with nodes fetched once via `nodesByIDs`.
const CALLER_EDGE_KINDS: ReadonlySet<CodegraphEdgeKind> = new Set(["calls", "references"])
// Every edge kind the indexer emits. `dependents`/`impact`/`walkTransitive`
// are intentionally unfiltered on kind: anything that points at the symbol
// is a dependent for impact-analysis purposes.
const ALL_EDGE_KINDS: ReadonlySet<CodegraphEdgeKind> = new Set([
  "imports",
  "calls",
  "extends",
  "references",
  "tested_by",
  "configured_by",
  "built_by",
  "mounts",
  "generated_from",
])
// 8 is enough for typical transitive impact; the UI truncates larger sets anyway.
const TRANSITIVE_MAX_DEPTH = 8
// Bounded so a wide graph can never materialize an unbounded result list.
const TRANSITIVE_RESULT_LIMIT = 500

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    const resolveNodeID = (input: { nodeID?: string; function?: string }) =>
      Effect.gen(function* () {
        if (input.nodeID) return input.nodeID
        if (!input.function) return undefined
        // Run the full resolver chain — not just exact-name — so Context.Service
        // tags, qualified Namespace.leaf splits, and code-substring matches all
        // count as "found". Previously only `repo.queryNodes({ function })`
        // ran, which silently missed every service class and most method calls.
        const result = yield* resolveGraphTargetPure(repo as never, { target: input.function })
        return result._tag === "Ok" ? result.value.nodeID : undefined
      })

    const callers = (input: { nodeID?: string; function?: string }): Effect.Effect<CodegraphNode[], SymbolNotFoundError> =>
      Effect.gen(function* () {
        const nodeID = yield* resolveNodeID(input)
        if (!nodeID) {
          return yield* new SymbolNotFoundError({ symbol: input.function ?? input.nodeID ?? "unknown" })
        }
        const run = yield* bfsPure(repo, {
          start: [nodeID],
          direction: "incoming",
          edgeKinds: CALLER_EDGE_KINDS,
          maxDepth: 1,
        })
        return run.results.map((r) => r.node)
      })

    const dependents = (input: { nodeID?: string; function?: string }): Effect.Effect<CodegraphNode[], SymbolNotFoundError> =>
      Effect.gen(function* () {
        const nodeID = yield* resolveNodeID(input)
        if (!nodeID) {
          return yield* new SymbolNotFoundError({ symbol: input.function ?? input.nodeID ?? "unknown" })
        }
        // `dependents` is intentionally unfiltered on edge kind: anything that
        // points at the symbol — extends, imports, calls, references, type-checks —
        // is a dependent for impact-analysis purposes. This mirrors what
        // `code_find intent=dependents` reported before the unification.
        const run = yield* bfsPure(repo, {
          start: [nodeID],
          direction: "incoming",
          edgeKinds: ALL_EDGE_KINDS,
          maxDepth: 1,
        })
        return run.results.map((r) => r.node)
      })

    const impact = (input: { nodeID?: string; function?: string }): Effect.Effect<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }, SymbolNotFoundError> =>
      Effect.gen(function* () {
        const nodeID = yield* resolveNodeID(input)
        if (!nodeID) {
          return yield* new SymbolNotFoundError({ symbol: input.function ?? input.nodeID ?? "unknown" })
        }
        const run = yield* bfsPure(repo, {
          start: [nodeID],
          direction: "incoming",
          edgeKinds: ALL_EDGE_KINDS,
          maxDepth: TRANSITIVE_MAX_DEPTH,
          resultLimit: TRANSITIVE_RESULT_LIMIT,
        })
        const dependents: CodegraphNode[] = []
        const transitive: CodegraphNode[] = []
        // bfsPure marks visited at enqueue, so every node appears exactly once
        // (a diamond reached via two parents yields a single result). Split on
        // first-discovery depth, mirroring repository-intelligence/layer.ts.
        for (const r of run.results) {
          if (r.depth === 1) dependents.push(r.node)
          else transitive.push(r.node)
        }
        return { dependents, transitive }
      })

    const walkTransitive = (input: { nodeID: string; direction: "upstream" | "downstream"; maxDepth?: number }): Effect.Effect<CodegraphNode[]> =>
      Effect.gen(function* () {
        const run = yield* bfsPure(repo, {
          start: [input.nodeID],
          direction: input.direction === "upstream" ? "incoming" : "outgoing",
          edgeKinds: ALL_EDGE_KINDS,
          maxDepth: input.maxDepth ?? TRANSITIVE_MAX_DEPTH,
          resultLimit: TRANSITIVE_RESULT_LIMIT,
        })
        return run.results.map((r) => r.node)
      })

    return Service.of({ callers, dependents, impact, walkTransitive })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
