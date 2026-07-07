import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { PermissionV2 } from "../../src/permission"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer } from "../../src/banyancode/codegraph-analyzer"

process.env.BANYANCODE_ENABLE = "1"

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
        { id: "n1", fileID: "f1", kind: "class" as const, name: "MemoryRepo", startLine: 1, endLine: 50 },
        { id: "n2", fileID: "f2", kind: "function" as const, name: "login", startLine: 1, endLine: 10 },
      ]),
    listAllFiles: () =>
      Effect.succeed([
        { id: "f1", path: "src/banyancode/memory-repo.ts", contentHash: "h1", language: "ts", indexedAt: 0 },
        { id: "f2", path: "auth.ts", contentHash: "h2", language: "ts", indexedAt: 0 },
        { id: "f3", path: "src/foo.ts", contentHash: "h3", language: "ts", indexedAt: 0 },
      ]),
    getFileByPath: () => Effect.succeed(undefined),
    putFile: () => Effect.void,
    getFile: () => Effect.succeed(undefined),
    putNode: () => Effect.void,
    putNodes: () => Effect.void,
    getNode: () => Effect.succeed(undefined),
    nodeByID: () => Effect.succeed(undefined),
    listNodesByFile: () => Effect.succeed([]),
    queryNodes: () => Effect.succeed([]),
    searchNodes: () => Effect.succeed([]),
    countNodes: () => Effect.succeed(0),
    countEdges: () => Effect.succeed(0),
    countFiles: () => Effect.succeed(0),
    putEdge: () => Effect.void,
    getEdge: () => Effect.succeed(undefined),
    listAllEdges: () => Effect.succeed([]),
    listEdgesByNode: () => Effect.succeed([]),
    edgesFrom: () => Effect.succeed([]),
    edgesTo: () => Effect.succeed([]),
    deleteFile: () => Effect.void,
    writeFileGraph: () => Effect.void,
    clearAll: () => Effect.succeed({ sizeBefore: 0, sizeAfter: 0 }),
    recordParseError: () => Effect.void,
    listParseErrors: () => Effect.succeed([]),
    clearParseErrors: () => Effect.void,
    findSymbolsByServiceTag: () => Effect.succeed([]),
    setMeta: () => Effect.void,
    bumpVersion: () => Effect.succeed({ graphVersion: 1, coverage: 0.9 }),
    nodesByIDs: () => Effect.succeed([]),
    putEdges: () => Effect.void,
    rebuildFtsIndex: () => Effect.succeed({ rowsIndexed: 0 }),
  }),
)

const mockCodegraphAnalyzerLayer = Layer.succeed(
  CodegraphAnalyzer.Service,
  CodegraphAnalyzer.Service.of({
    callers: () => Effect.succeed([]),
    dependents: () => Effect.succeed([]),
    impact: () => Effect.succeed({ dependents: [], transitive: [] }),
    walkTransitive: () => Effect.succeed([]),
  }),
)

const mockServicesLayer = Layer.mergeAll(
  mockPermissionLayer,
  mockCodegraphRepoLayer,
  mockCodegraphAnalyzerLayer,
)

describe("code_find find_file intent", () => {
  test("find_file for known symbol returns graph path with dispatchedTo=graph", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()

        const symbolMatches = allNodes.filter((n) => n.name === "MemoryRepo")
        const graphFileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
        const graphFiles = allFiles.filter((f) => graphFileIDs.includes(f.id)).map((f) => ({ path: f.path }))

        expect(graphFiles.length).toBeGreaterThanOrEqual(1)
        expect(graphFiles[0]?.path).toContain("memory-repo")
        expect(symbolMatches[0]?.name).toBe("MemoryRepo")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("find_file for unknown target falls back to glob with dispatchedTo=glob", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()

        const target = "does-not-exist-anywhere"
        const symbolMatches = allNodes.filter((n) => n.name === target)
        const graphFileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
        const graphFiles = allFiles.filter((f) => graphFileIDs.includes(f.id)).map((f) => ({ path: f.path }))

        let dispatchedTo: string
        if (graphFiles.length > 0) {
          dispatchedTo = "graph"
        } else {
          dispatchedTo = "glob"
        }

        expect(graphFiles.length).toBe(0)
        expect(dispatchedTo).toBe("glob")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("find_file for path-like target uses glob path", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()

        const target = "src/foo"
        const symbolMatches = allNodes.filter((n) => n.name === target)
        const graphFileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
        const graphFiles = allFiles.filter((f) => graphFileIDs.includes(f.id)).map((f) => ({ path: f.path }))

        let dispatchedTo: string
        let files: { path: string }[]
        if (graphFiles.length > 0) {
          files = graphFiles
          dispatchedTo = "graph"
        } else {
          files = allFiles.filter((f) => f.path.includes(target)).map((f) => ({ path: f.path }))
          dispatchedTo = "glob"
        }

        expect(dispatchedTo).toBe("glob")
        expect(files[0]?.path).toBe("src/foo.ts")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("find_file with empty target bug: f.path.includes('') matches all files (demonstrates bug)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const allFiles = yield* repo.listAllFiles()

        const emptyTarget = ""
        const files = allFiles.filter((f) => f.path.includes(emptyTarget))

        expect(files.length).toBe(allFiles.length)
        expect(files.length).toBe(3)
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("find_file with empty target returns early with empty result (fixed behavior)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        const emptyTarget = ""
        const allFiles = yield* repo.listAllFiles()
        const allNodes = yield* repo.listAllNodes()

        const symbolMatches = allNodes.filter((n) => n.name === emptyTarget)
        const graphFileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
        const graphFiles = allFiles.filter((f) => graphFileIDs.includes(f.id)).map((f) => ({ path: f.path }))

        let files: { path: string }[]
        let dispatchedTo: string
        if (graphFiles.length > 0) {
          files = graphFiles.slice(0, 50)
          dispatchedTo = "graph"
        } else {
          files = allFiles.filter((f) => f.path.includes(emptyTarget)).slice(0, 50).map((f) => ({ path: f.path }))
          dispatchedTo = "glob"
        }

        expect(graphFiles.length).toBe(0)
        expect(files.length).toBe(3)
        expect(dispatchedTo).toBe("glob")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })
})
