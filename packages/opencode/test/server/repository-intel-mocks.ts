import { Effect, Layer, Queue } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type {
  ArchitecturalSlice,
  CodegraphNode,
  RepositoryContext,
  WorkspaceContext,
} from "@opencode-ai/core/banyancode/types"

const emptySlice: ArchitecturalSlice = {
  summary: "empty",
  entrypoints: [],
  directCallers: [],
  transitiveDependents: [],
  importantSymbols: [],
  relatedTests: [],
  relatedDocs: [],
  configs: [],
  routes: [],
  dependencies: [],
}

const emptyContext = (query: string, workspace?: WorkspaceContext): RepositoryContext => ({
  query,
  symbols: [],
  files: [],
  graph: { nodes: [], edges: [] },
  tests: [],
  docs: [],
  configs: [],
  git: { recentCommits: [], ownership: new Map<string, number>() },
  workspace,
  ranking: {
    score: 0,
    signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 },
  },
})

export const repositoryIntelServiceMocks = Layer.mergeAll(
  Layer.succeed(
    Banyan.RepositoryIntelligence,
    Banyan.RepositoryIntelligence.of({
      query: ({ query, workspace }) => Effect.succeed(emptyContext(query, workspace)),
      slice: (_ctx) => Effect.succeed(emptySlice),
      explain: () => Effect.succeed(emptySlice),
      impact: () => Effect.succeed(emptySlice),
      trace: () => Effect.succeed(emptySlice),
      tests: () => Effect.succeed({ tests: [] as readonly CodegraphNode[], notFound: false }),
      symbols: () => Effect.succeed([] as readonly CodegraphNode[]),
      relationships: () => Effect.succeed([] as readonly CodegraphNode[]),
      findOwner: () => Effect.succeed({ owner: undefined, count: 0 }),
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
      findInterfaces: () => Effect.succeed([]),
      findExports: () => Effect.succeed([]),
      findImports: () => Effect.succeed([]),
    }),
  ),
  Layer.succeed(
    Banyan.MemoryRepo,
    Banyan.MemoryRepo.of({
      put: () => Effect.void,
      get: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      forget: () => Effect.void,
      forgetByKey: () => Effect.succeed(0),
      search: () => Effect.succeed([]),
      searchRanked: () => Effect.succeed({ entries: [], totalHits: 0 }),
      vacuum: () => Effect.succeed(0),
      update: () => Effect.die("not used"),
    }),
  ),
  Layer.succeed(
    Banyan.MemoryService,
    Banyan.MemoryService.of({
      emitCandidate: () => Effect.die("not used"),
      promote: () => Effect.die("not used"),
      reject: () => Effect.die("not used"),
      listCandidates: () => Effect.succeed([]),
      events: () => {
        // Mock Dequeue — the bridge never runs in HTTP tests, so this is never
        // taken from. `as never` narrows it past the Queue.Dequeue type-check.
        const queue = {} as never
        return queue as unknown as Queue.Dequeue<never>
      },
    }),
  ),
  Layer.succeed(
    Banyan.MemoryProjection,
    Banyan.MemoryProjection.of({
      projectSummary: () =>
        Effect.succeed({
          totalActive: 0,
          byKind: [],
          generatedAt: 0,
        }),
      activeDecisions: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
      activeWarnings: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
      recentChanges: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
      openTodos: () => Effect.succeed({ entries: [], totalActive: 0, generatedAt: 0 }),
      agentWorkingNotes: () => Effect.succeed({ agentID: "", entries: [], generatedAt: 0 }),
      decisionDigest: () => Effect.succeed({ items: [], generatedAt: 0, totalActive: 0 }),
      warningDigest: () => Effect.succeed({ items: [], generatedAt: 0, totalActive: 0 }),
    }),
  ),
)
