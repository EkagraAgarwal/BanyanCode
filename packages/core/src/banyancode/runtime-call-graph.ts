export * as RuntimeCallGraph from "./runtime-call-graph"

import { Context, Effect, Layer } from "effect"
import { CodegraphAnalyzer } from "./codegraph-analyzer"
import { TraceCollector } from "./trace-collector"
import type { CodegraphEdge, CodegraphNode } from "./types"

export interface DiffResult {
  readonly onlyStatic: readonly CodegraphNode[]
  readonly onlyRuntime: readonly CodegraphNode[]
  readonly both: readonly CodegraphNode[]
}

export interface Interface {
  readonly observedEdges: (input: { since?: number; traceName?: string }) => Effect.Effect<readonly CodegraphEdge[], never, never>
  readonly observedCallers: (input: { nodeID: string; since?: number }) => Effect.Effect<readonly CodegraphNode[], never, never>
  readonly diffStaticVsRuntime: (input: { nodeID: string; since?: number }) => Effect.Effect<DiffResult, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/RuntimeCallGraph") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const collector = yield* TraceCollector.Service
    const analyzer = yield* CodegraphAnalyzer.Service

    const observedEdges = (input: { since?: number; traceName?: string }): Effect.Effect<readonly CodegraphEdge[], never, never> =>
      collector.observedEdges(input)

    const observedCallers = (input: { nodeID: string; since?: number }): Effect.Effect<readonly CodegraphNode[], never, never> =>
      collector.observedCallers(input)

    const diffStaticVsRuntime = (input: { nodeID: string; since?: number }): Effect.Effect<DiffResult, never, never> =>
      Effect.gen(function* () {
        const staticCallers = yield* analyzer.callers({ nodeID: input.nodeID }).pipe(
          Effect.catchCause(() => Effect.succeed([] as CodegraphNode[])),
        )
        const runtimeCallers = yield* collector.observedCallers(input)
        const staticIDs = new Set(staticCallers.map((n) => n.id))
        const runtimeIDs = new Set(runtimeCallers.map((n) => n.id))
        const onlyStatic = staticCallers.filter((n) => !runtimeIDs.has(n.id))
        const onlyRuntime = runtimeCallers.filter((n) => !staticIDs.has(n.id))
        const both = staticCallers.filter((n) => runtimeIDs.has(n.id))
        return { onlyStatic, onlyRuntime, both }
      })

    return Service.of({ observedEdges, observedCallers, diffStaticVsRuntime })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(TraceCollector.defaultLayer), Layer.provide(CodegraphAnalyzer.defaultLayer))