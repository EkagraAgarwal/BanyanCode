import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { CodegraphNode } from "@opencode-ai/core/banyancode/types"

const emptyNode: CodegraphNode = {
  id: "empty",
  fileID: "empty",
  kind: "function",
  name: "empty",
  startLine: 0,
  endLine: 0,
}

export const repositoryIntelServiceMocks = Layer.mergeAll(
  Layer.succeed(
    Banyan.RepositoryIntelligence,
    Banyan.RepositoryIntelligence.of({
      findSymbol: () => Effect.succeed([]),
      findSubsystem: () => Effect.succeed({ entry: emptyNode, related: [] }),
      findEntrypoints: () => Effect.succeed([]),
      findTests: () => Effect.succeed([]),
      findRelated: () => Effect.succeed([]),
      estimateImpact: () => Effect.succeed({ direct: [], transitive: [], blastRadius: 0 }),
      traceExecution: () => Effect.succeed([]),
    }),
  ),
  Layer.succeed(
    Banyan.Search,
    Banyan.Search.of({
      searchExact: () => Effect.succeed([]),
      searchPrefix: () => Effect.succeed([]),
      searchCamelCase: () => Effect.succeed([]),
      searchSnakeCase: () => Effect.succeed([]),
      searchQualified: () => Effect.succeed([]),
      searchBM25: () => Effect.succeed([]),
      searchFuzzy: () => Effect.succeed([]),
      search: () => Effect.succeed([]),
    }),
  ),
  Layer.succeed(
    Banyan.StructuralQueries,
    Banyan.StructuralQueries.of({
      findImplementations: () => Effect.succeed([]),
      findOverrides: () => Effect.succeed([]),
      findRecursiveFunctions: () => Effect.succeed([]),
      findAsyncFunctions: () => Effect.succeed([]),
      findHTTPRoutes: () => Effect.succeed([]),
    }),
  ),
)
