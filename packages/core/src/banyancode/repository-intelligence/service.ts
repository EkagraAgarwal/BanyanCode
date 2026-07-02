import { Context, Effect } from "effect"
import type { CodegraphNode } from "../types"

export interface Interface {
  readonly findSymbol: (input: {
    name: string
    kind?: CodegraphNode["kind"]
    file?: string
    exact?: boolean
  }) => Effect.Effect<CodegraphNode[], never, never>

  readonly findSubsystem: (input: {
    query: string
    maxDepth?: number
  }) => Effect.Effect<{ entry: CodegraphNode; related: CodegraphNode[] }, never, never>

  readonly findEntrypoints: (input: {
    feature: string
  }) => Effect.Effect<CodegraphNode[], never, never>

  readonly findTests: (input: {
    symbol: string
  }) => Effect.Effect<CodegraphNode[], never, never>

  readonly findRelated: (input: {
    nodeID: string
    depth?: number
  }) => Effect.Effect<CodegraphNode[], never, never>

  readonly estimateImpact: (input: {
    paths: string[]
    maxDepth?: number
  }) => Effect.Effect<{
    direct: CodegraphNode[]
    transitive: CodegraphNode[]
    blastRadius: number
  }, never, never>

  readonly traceExecution: (input: {
    from: string
    maxDepth?: number
  }) => Effect.Effect<CodegraphNode[], never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/RepositoryIntelligence") {}
