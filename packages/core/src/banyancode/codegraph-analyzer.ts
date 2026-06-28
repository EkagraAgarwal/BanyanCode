export * as CodegraphAnalyzer from "./codegraph-analyzer"

import { Context, Effect, Layer } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import type { CodegraphNode } from "./types"

export interface Interface {
  readonly callers: (input: { nodeID?: string; function?: string }) => Effect.Effect<CodegraphNode[]>
  readonly dependents: (input: { nodeID?: string; function?: string }) => Effect.Effect<CodegraphNode[]>
  readonly impact: (input: { nodeID?: string; function?: string }) => Effect.Effect<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }>
  readonly walkTransitive: (input: { nodeID: string; direction: "upstream" | "downstream"; maxDepth?: number }) => Effect.Effect<CodegraphNode[]>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphAnalyzer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    const callers = (input: { nodeID?: string; function?: string }): Effect.Effect<CodegraphNode[]> =>
      Effect.gen(function* () {
        const nodeID = input.nodeID ?? (input.function ? (yield* repo.queryNodes({ function: input.function }))[0]?.id : undefined)
        if (!nodeID) return []
        const edges = yield* repo.edgesTo(nodeID)
        const callerIDs = [...new Set(edges.filter((e) => e.kind === "calls" || e.kind === "references").map((e) => e.fromNodeID))]
        return yield* repo.nodesByIDs(callerIDs)
      })

    const dependents = (input: { nodeID?: string; function?: string }): Effect.Effect<CodegraphNode[]> =>
      Effect.gen(function* () {
        const nodeID = input.nodeID ?? (input.function ? (yield* repo.queryNodes({ function: input.function }))[0]?.id : undefined)
        if (!nodeID) return []
        const edges = yield* repo.edgesTo(nodeID)
        const dependentIDs = [...new Set(edges.map((e) => e.fromNodeID))]
        return yield* repo.nodesByIDs(dependentIDs)
      })

    const impact = (input: { nodeID?: string; function?: string }): Effect.Effect<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }> =>
      Effect.gen(function* () {
        const nodeID = input.nodeID ?? (input.function ? (yield* repo.queryNodes({ function: input.function }))[0]?.id : undefined)
        if (!nodeID) return { dependents: [], transitive: [] }
        const direct = yield* dependents({ nodeID })
        const downstreamTransitive = yield* walkTransitive({ nodeID, direction: "downstream" })
        const upstreamTransitive = yield* walkTransitive({ nodeID, direction: "upstream" })
        const seen = new Set<string>()
        const transitive: CodegraphNode[] = []
        for (const n of [...downstreamTransitive, ...upstreamTransitive]) {
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
