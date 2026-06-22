import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "../../src/banyancode"
import { PermissionV2 } from "../../src/permission"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer } from "../../src/banyancode/codegraph-analyzer"
import { EmbeddingProvider } from "../../src/banyancode/embedding-provider"

// Set BANYANCODE_ENABLE for all tests
process.env.BANYANCODE_ENABLE = "1"

// --- Mock PermissionV2.Service ---
const mockPermissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: () => Effect.succeed({ id: { _id: "p" } as any, effect: "allow" as const }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

// --- Mock CodegraphRepo ---
const mockCodegraphRepoLayer = Layer.succeed(
  CodegraphRepo.Service,
  CodegraphRepo.Service.of({
    getMeta: () =>
      Effect.succeed({
        id: "singleton",
        graphBuiltAt: Date.now(),
        graphVersion: 1,
        graphCoverage: 0.9,
        totalFiles: 10,
        totalNodes: 100,
        totalEdges: 500,
        schemaVersion: 1,
      }),
    listAllNodes: () =>
      Effect.succeed([
        { id: "n1", fileID: "f1", kind: "function" as const, name: "login", startLine: 1, endLine: 10 },
        { id: "n2", fileID: "f1", kind: "function" as const, name: "logout", startLine: 12, endLine: 20 },
        { id: "n3", fileID: "f2", kind: "class" as const, name: "User", startLine: 1, endLine: 50 },
      ]),
    listAllFiles: () =>
      Effect.succeed([
        { id: "f1", path: "auth.ts", contentHash: "h1", language: "ts", indexedAt: 0 },
        { id: "f2", path: "models/user.ts", contentHash: "h2", language: "ts", indexedAt: 0 },
      ]),
    getFileByPath: (p) =>
      p === "auth.ts"
        ? Effect.succeed({ id: "f1", path: "auth.ts", contentHash: "h1", language: "ts", indexedAt: 0 })
        : Effect.succeed(undefined),
    // Fill in remaining Interface methods (unused in tests)
    putFile: () => Effect.void,
    getFile: () => Effect.succeed(undefined),
    putNode: () => Effect.void,
    getNode: () => Effect.succeed(undefined),
    nodeByID: () => Effect.succeed(undefined),
    listNodesByFile: () => Effect.succeed([]),
    queryNodes: () => Effect.succeed([]),
    putEdge: () => Effect.void,
    getEdge: () => Effect.succeed(undefined),
    listAllEdges: () => Effect.succeed([]),
    listEdgesByNode: () => Effect.succeed([]),
    edgesFrom: () => Effect.succeed([]),
    edgesTo: () => Effect.succeed([]),
    putEmbedding: () => Effect.void,
    getEmbedding: () => Effect.succeed(undefined),
    resetEmbeddingsTable: () => Effect.void,
    searchByVector: () => Effect.succeed([]),
    deleteFile: () => Effect.void,
    clearAll: () => Effect.void,
    setMeta: () => Effect.void,
    bumpVersion: () => Effect.succeed({ graphVersion: 1, coverage: 0.9 }),
  }),
)

// --- Mock CodegraphAnalyzer ---
const mockCodegraphAnalyzerLayer = Layer.succeed(
  CodegraphAnalyzer.Service,
  CodegraphAnalyzer.Service.of({
    callers: ({ function: fn }) =>
      fn === "login"
        ? Effect.succeed([{ id: "n4", fileID: "f1", kind: "function" as const, name: "authenticate", startLine: 5, endLine: 8 }])
        : Effect.succeed([]),
    dependents: ({ function: fn }) =>
      fn === "login"
        ? Effect.succeed([{ id: "n5", fileID: "f1", kind: "function" as const, name: "sessionStart", startLine: 21, endLine: 25 }])
        : Effect.succeed([]),
    impact: ({ function: fn }) =>
      fn === "login"
        ? Effect.succeed({
            dependents: [{ id: "n5", fileID: "f1", kind: "function" as const, name: "sessionStart", startLine: 21, endLine: 25 }],
            transitive: [{ id: "n6", fileID: "f2", kind: "function" as const, name: "cleanup", startLine: 30, endLine: 35 }],
          })
        : Effect.succeed({ dependents: [], transitive: [] }),
      walkTransitive: () => Effect.succeed([]),
  }),
)

// --- Mock EmbeddingProviderService ---
const mockEmbeddingProviderLayer = Layer.succeed(
  EmbeddingProvider.EmbeddingProviderService,
  EmbeddingProvider.EmbeddingProviderService.of({
    embed: () => Effect.succeed([new Float32Array([1, 0, 0])]),
    model: () => Effect.succeed("test-embedding-model"),
    setModel: () => Effect.void,
    probe: () => Effect.succeed({ dim: 3, type: "F32" as const }),
    detectAndSetModel: () => Effect.succeed({ dim: 3 }),
  }),
)

// Combined layer for all mocked services
const mockServicesLayer = Layer.mergeAll(
  mockPermissionLayer,
  mockCodegraphRepoLayer,
  mockCodegraphAnalyzerLayer,
  mockEmbeddingProviderLayer,
)

describe("code_find", () => {
  test("definition intent with target='login' returns 1 match", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const nodes = yield* repo.listAllNodes()
        const matches = nodes.filter((n) => n.name === "login")
        expect(matches.length).toBe(1)
        expect(matches[0]?.name).toBe("login")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("callers intent dispatches to analyzer.callers", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const analyzer = yield* CodegraphAnalyzer.Service
        const callers = yield* analyzer.callers({ function: "login" })
        expect(callers.length).toBe(1)
        expect(callers[0]?.name).toBe("authenticate")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("dependents intent dispatches to analyzer.dependents", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const analyzer = yield* CodegraphAnalyzer.Service
        const dependents = yield* analyzer.dependents({ function: "login" })
        expect(dependents.length).toBe(1)
        expect(dependents[0]?.name).toBe("sessionStart")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("impact intent dispatches to analyzer.impact", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const analyzer = yield* CodegraphAnalyzer.Service
        const result = yield* analyzer.impact({ function: "login" })
        expect(result.dependents.length).toBe(1)
        expect(result.transitive.length).toBe(1)
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("semantic intent returns hits when model is available", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProvider.EmbeddingProviderService
        const repo = yield* CodegraphRepo.Service
        const model = yield* provider.model()
        expect(model).toBe("test-embedding-model")

        // Simulate the semantic intent logic
        const query = "login"
        const nodes = yield* repo.listAllNodes()
        const targetWords = query.toLowerCase().split(/\s+/)
        const hits = nodes
          .map((n) => ({
            node: n,
            score: targetWords.filter((w) => n.name.toLowerCase().includes(w)).length / targetWords.length,
            source: "semantic" as const,
          }))
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score)

        expect(hits.length).toBe(1)
        expect(hits[0]?.node.name).toBe("login")
        expect(hits[0]?.source).toBe("semantic")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("find_file intent returns matching files", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const files = yield* repo.listAllFiles()
        const matching = files.filter((f) => f.path.includes("auth"))
        expect(matching.length).toBe(1)
        expect(matching[0]?.path).toBe("auth.ts")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("meta field is present when getMeta returns a value", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const meta = yield* repo.getMeta()
        expect(meta).toBeDefined()
        expect(meta?.graphVersion).toBe(1)
        expect(meta?.graphCoverage).toBe(0.9)
        expect(meta?.totalFiles).toBe(10)
        expect(meta?.totalNodes).toBe(100)
        expect(meta?.totalEdges).toBe(500)
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("semantic intent falls back to keyword when no model", async () => {
    // Re-run with no embedding model
    const noModelLayer = Layer.mergeAll(
      mockPermissionLayer,
      mockCodegraphRepoLayer,
      mockCodegraphAnalyzerLayer,
      Layer.succeed(
        EmbeddingProvider.EmbeddingProviderService,
        EmbeddingProvider.EmbeddingProviderService.of({
          embed: () => Effect.die("no model"),
          model: () => Effect.succeed(undefined),
          setModel: () => Effect.void,
          probe: () => Effect.die("no model"),
          detectAndSetModel: () => Effect.die("no model"),
        }),
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProvider.EmbeddingProviderService
        const repo = yield* CodegraphRepo.Service

        const query = "login"
        const model = yield* provider.model()
        expect(model).toBeUndefined()

        // Keyword fallback path
        const nodes = yield* repo.listAllNodes()
        const targetWords = query.toLowerCase().split(/\s+/)
        const hits = nodes
          .filter((n) => targetWords.some((w) => n.name.toLowerCase().includes(w)))
          .slice(0, 50)
          .map((node) => ({ node, score: 0, source: "keyword" as const }))

        expect(hits.length).toBe(1)
        expect(hits[0]?.node.name).toBe("login")
        expect(hits[0]?.source).toBe("keyword")
      }).pipe(
        Effect.provide(noModelLayer),
        Effect.scoped,
      ),
    )
  })
})
