import { Context, Effect } from "effect"
import type { ArchitecturalSlice, CodegraphNode, RepositoryContext, WorkspaceContext } from "../types"

export interface Interface {
  readonly query: (input: { query: string; limit?: number; workspace?: WorkspaceContext }) => Effect.Effect<RepositoryContext, never, never>
  readonly slice: (ctx: RepositoryContext) => Effect.Effect<ArchitecturalSlice, never, never>
  readonly explain: (input: { symbol: string; workspace?: WorkspaceContext }) => Effect.Effect<ArchitecturalSlice, never, never>
  readonly impact: (input: { path: string; workspace?: WorkspaceContext }) => Effect.Effect<ArchitecturalSlice, never, never>
  readonly trace: (input: { symbol: string; depth?: number; workspace?: WorkspaceContext }) => Effect.Effect<ArchitecturalSlice, never, never>
  readonly tests: (input: { symbol: string }) => Effect.Effect<readonly CodegraphNode[], never, never>
  readonly symbols: (input: { query: string; limit?: number }) => Effect.Effect<readonly CodegraphNode[], never, never>
  readonly relationships: (input: { nodeID: string; depth?: number }) => Effect.Effect<readonly CodegraphNode[], never, never>
  readonly findOwner: (input: { path: string }) => Effect.Effect<{ owner?: string; count: number }, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/RepositoryIntelligence") {}
