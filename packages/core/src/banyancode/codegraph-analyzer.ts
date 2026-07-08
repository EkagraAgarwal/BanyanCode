export * as CodegraphAnalyzer from "./codegraph-analyzer"

import { Context, Effect, Layer, Schema } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import { resolveGraphTargetPure } from "./symbol-resolver"
import type { CodegraphNode } from "./types"

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
        const edges = yield* repo.edgesTo(nodeID)
        const callerIDs = [...new Set(edges.filter((e) => e.kind === "calls" || e.kind === "references").map((e) => e.fromNodeID))]
        return yield* repo.nodesByIDs(callerIDs)
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
        const edges = yield* repo.edgesTo(nodeID)
        const dependentIDs = [...new Set(edges.map((e) => e.fromNodeID))]
        return yield* repo.nodesByIDs(dependentIDs)
      })

    const impact = (input: { nodeID?: string; function?: string }): Effect.Effect<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }, SymbolNotFoundError> =>
      Effect.gen(function* () {
        const nodeID = yield* resolveNodeID(input)
        if (!nodeID) {
          return yield* new SymbolNotFoundError({ symbol: input.function ?? input.nodeID ?? "unknown" })
        }
        const direct = yield* dependents({ nodeID })
        const upstreamTransitive = yield* walkTransitive({ nodeID, direction: "upstream" })
        const seen = new Set<string>()
        const transitive: CodegraphNode[] = []
        for (const n of upstreamTransitive) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            transitive.push(n)
          }
        }
        return { dependents: direct, transitive }
      })

    const walkTransitive = (input: { nodeID: string; direction: "upstream" | "downstream"; maxDepth?: number }): Effect.Effect<CodegraphNode[]> =>
      Effect.gen(function* () {
        const visited = new Set<string>()
        const queue: Array<{ id: string; depth: number }> = [{ id: input.nodeID, depth: 0 }]
        // 8 is enough for typical transitive impact; the UI truncates larger sets anyway.
        const maxDepth = input.maxDepth ?? 8
        const result: CodegraphNode[] = []

        while (queue.length > 0) {
          const current = queue.shift()!
          if (visited.has(current.id) || current.depth > maxDepth) continue
          visited.add(current.id)

          const edges = input.direction === "upstream"
            ? yield* repo.edgesTo(current.id)
            : yield* repo.edgesFrom(current.id)

          const nextIDs: string[] = []
          for (const edge of edges) {
            const nextID = input.direction === "upstream" ? edge.fromNodeID : edge.toNodeID
            if (!visited.has(nextID)) {
              queue.push({ id: nextID, depth: current.depth + 1 })
              nextIDs.push(nextID)
            }
          }
          if (nextIDs.length > 0) {
            const nodes = yield* repo.nodesByIDs(nextIDs)
            result.push(...nodes)
          }
        }

        return result
      })

    return Service.of({ callers, dependents, impact, walkTransitive })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CodegraphRepo.defaultLayer))
