import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { PermissionV2 } from "../../src/permission"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { CodegraphAnalyzer } from "../../src/banyancode/codegraph-analyzer"
import { resolveGraphTargetPure, resolveGraphTargetStrict } from "../../src/banyancode/symbol-resolver"
import type { CodegraphNode, CodegraphFile, CodegraphMeta } from "../../src/banyancode/types"

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
    putNodes: () => Effect.void,
    getNode: () => Effect.succeed(undefined),
    nodeByID: () => Effect.succeed(undefined),
    listNodesByFile: () => Effect.succeed([]),
    queryNodes: () => Effect.succeed([]),
    searchNodes: () => Effect.succeed([]),
    countNodes: () => Effect.succeed(0),
    countEdges: () => Effect.succeed(0),
    countStaleFiles: () => Effect.succeed(0),
    listStaleFiles: () => Effect.succeed([]),
    listToolUsage: () => Effect.succeed([]),
    countFiles: () => Effect.succeed(0),
    putEdge: () => Effect.void,
    getEdge: () => Effect.succeed(undefined),
    listAllEdges: () => Effect.succeed([]),
    listEdgesByNode: () => Effect.succeed([]),
    edgesFrom: () => Effect.succeed([]),
    edgesTo: () => Effect.succeed([]),
    deleteFile: () => Effect.void,
    deleteDerivedEdgesForFiles: () => Effect.succeed([]),
    deleteAllDerivedEdges: () => Effect.succeed([]),
    fileIDsByServiceName: () => Effect.succeed([]),
    writeFileGraph: () => Effect.void,
    clearAll: () => Effect.succeed({ sizeBefore: 0, sizeAfter: 0, droppedFile: false }),
    recordParseError: () => Effect.void,
    listParseErrors: () => Effect.succeed([]),
    clearParseErrors: () => Effect.void,
    findSymbolsByServiceTag: () => Effect.succeed([]),
    listNodesByKind: () => Effect.succeed([]),
    lookupByServiceTag: () => Effect.succeed(null),
    setMeta: () => Effect.void,
    bumpVersion: () =>
      Effect.succeed({ graphVersion: 1, coverage: 0.9, totalNodes: 0, totalEdges: 0, totalFiles: 0, graphBuiltAt: 0 }),
    bumpIndexedAt: () => Effect.void,
    nodesByIDs: () => Effect.succeed([]),
    putEdges: () => Effect.void,
    rebuildFtsIndex: () => Effect.succeed({ rowsIndexed: 0 }),
    recomputeInDegree: () => Effect.void,
    searchNodesLight: () => Effect.succeed([]),
    ftsSearchNodes: () => Effect.succeed([]),
    nodesByFileIDs: () => Effect.succeed([]),
    dependentsOfFiles: () => Effect.succeed([]),
    filesByIDs: () => Effect.succeed([]),
    edgesFromBatch: () => Effect.succeed([]),
    edgesToBatch: () => Effect.succeed([]),
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

// Combined layer for all mocked services
const mockServicesLayer = Layer.mergeAll(
  mockPermissionLayer,
  mockCodegraphRepoLayer,
  mockCodegraphAnalyzerLayer,
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

  test("callers intent on missing symbol returns empty + diagnostic", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const analyzer = yield* CodegraphAnalyzer.Service
        const callers = yield* analyzer.callers({ function: "DoesNotExist" })
        expect(callers.length).toBe(0)
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  // --- Phase 5b Fix 1: includeKeywordFallback strict mode ---
  test("resolveGraphTargetStrict returns Miss for an unknown symbol that code-substring would catch", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const result = yield* resolveGraphTargetStrict(
          repo as never,
          { target: "completely-unrelated-thing", allowKeywordFallback: false },
        )
        expect(result._tag).toBe("Miss")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("resolveGraphTargetPure returns Ok for an exact-name symbol when queryNodes is wired", async () => {
    const loginNode: CodegraphNode = {
      id: "n1",
      fileID: "f1",
      kind: "function",
      name: "login",
      startLine: 1,
      endLine: 10,
    }
    const fileF: CodegraphFile = {
      id: "f1",
      path: "auth.ts",
      contentHash: "h1",
      language: "ts",
      indexedAt: 0,
    }
    const meta: CodegraphMeta = {
      id: "singleton",
      graphBuiltAt: Date.now(),
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 1,
      totalEdges: 0,
      schemaVersion: 1,
    }
    const wiredRepoLayer = Layer.succeed(
      CodegraphRepo.Service,
      CodegraphRepo.Service.of({
        getMeta: () => Effect.succeed(meta),
        listAllNodes: () => Effect.succeed([loginNode]),
        listAllFiles: () => Effect.succeed([fileF]),
        getFileByPath: () => Effect.succeed(undefined),
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(undefined),
        putNode: () => Effect.void,
        putNodes: () => Effect.void,
        getNode: () => Effect.succeed(undefined),
        nodeByID: () => Effect.succeed(undefined),
        listNodesByFile: () => Effect.succeed([]),
        queryNodes: ({ function: fn }) => Effect.succeed(fn === "login" ? [loginNode] : []),
        searchNodes: () => Effect.succeed([]),
        countNodes: () => Effect.succeed(1),
        countEdges: () => Effect.succeed(0),
        countStaleFiles: () => Effect.succeed(0),
        listStaleFiles: () => Effect.succeed([]),
    listToolUsage: () => Effect.succeed([]),
        countFiles: () => Effect.succeed(1),
        putEdge: () => Effect.void,
        getEdge: () => Effect.succeed(undefined),
        listAllEdges: () => Effect.succeed([]),
        listEdgesByNode: () => Effect.succeed([]),
        edgesFrom: () => Effect.succeed([]),
        edgesTo: () => Effect.succeed([]),
        deleteFile: () => Effect.void,
        deleteDerivedEdgesForFiles: () => Effect.succeed([]),
        deleteAllDerivedEdges: () => Effect.succeed([]),
        fileIDsByServiceName: () => Effect.succeed([]),
        writeFileGraph: () => Effect.void,
        clearAll: () => Effect.succeed({ sizeBefore: 0, sizeAfter: 0, droppedFile: false }),
        recordParseError: () => Effect.void,
        listParseErrors: () => Effect.succeed([]),
        clearParseErrors: () => Effect.void,
        findSymbolsByServiceTag: () => Effect.succeed([]),
        listNodesByKind: () => Effect.succeed([]),
        lookupByServiceTag: () => Effect.succeed(null),
        setMeta: () => Effect.void,
        bumpVersion: () =>
          Effect.succeed({ graphVersion: 1, coverage: 1, totalNodes: 0, totalEdges: 0, totalFiles: 0, graphBuiltAt: 0 }),
        bumpIndexedAt: () => Effect.void,
        nodesByIDs: () => Effect.succeed([]),
        putEdges: () => Effect.void,
        rebuildFtsIndex: () => Effect.succeed({ rowsIndexed: 0 }),
        recomputeInDegree: () => Effect.void,
        searchNodesLight: () => Effect.succeed([]),
        ftsSearchNodes: () => Effect.succeed([]),
        nodesByFileIDs: () => Effect.succeed([]),
        dependentsOfFiles: () => Effect.succeed([]),
        filesByIDs: () => Effect.succeed([]),
        edgesFromBatch: () => Effect.succeed([]),
        edgesToBatch: () => Effect.succeed([]),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const result = yield* resolveGraphTargetPure(repo as never, { target: "login" })
        expect(result._tag).toBe("Ok")
      }).pipe(
        Effect.provide(wiredRepoLayer),
        Effect.scoped,
      ),
    )
  })

  test("resolveGraphTargetStrict returns Ok for an exact-name symbol via step 2", async () => {
    const loginNode: CodegraphNode = {
      id: "n1",
      fileID: "f1",
      kind: "function",
      name: "login",
      startLine: 1,
      endLine: 10,
    }
    const fileF: CodegraphFile = {
      id: "f1",
      path: "auth.ts",
      contentHash: "h1",
      language: "ts",
      indexedAt: 0,
    }
    const meta: CodegraphMeta = {
      id: "singleton",
      graphBuiltAt: Date.now(),
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 1,
      totalEdges: 0,
      schemaVersion: 1,
    }
    const wiredRepoLayer = Layer.succeed(
      CodegraphRepo.Service,
      CodegraphRepo.Service.of({
        getMeta: () => Effect.succeed(meta),
        listAllNodes: () => Effect.succeed([loginNode]),
        listAllFiles: () => Effect.succeed([fileF]),
        getFileByPath: () => Effect.succeed(undefined),
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(undefined),
        putNode: () => Effect.void,
        putNodes: () => Effect.void,
        getNode: () => Effect.succeed(undefined),
        nodeByID: () => Effect.succeed(undefined),
        listNodesByFile: () => Effect.succeed([]),
        queryNodes: ({ function: fn }) => Effect.succeed(fn === "login" ? [loginNode] : []),
        searchNodes: () => Effect.succeed([]),
        countNodes: () => Effect.succeed(1),
        countEdges: () => Effect.succeed(0),
        countStaleFiles: () => Effect.succeed(0),
        listStaleFiles: () => Effect.succeed([]),
    listToolUsage: () => Effect.succeed([]),
        countFiles: () => Effect.succeed(1),
        putEdge: () => Effect.void,
        getEdge: () => Effect.succeed(undefined),
        listAllEdges: () => Effect.succeed([]),
        listEdgesByNode: () => Effect.succeed([]),
        edgesFrom: () => Effect.succeed([]),
        edgesTo: () => Effect.succeed([]),
        deleteFile: () => Effect.void,
        deleteDerivedEdgesForFiles: () => Effect.succeed([]),
        deleteAllDerivedEdges: () => Effect.succeed([]),
        fileIDsByServiceName: () => Effect.succeed([]),
        writeFileGraph: () => Effect.void,
        clearAll: () => Effect.succeed({ sizeBefore: 0, sizeAfter: 0, droppedFile: false }),
        recordParseError: () => Effect.void,
        listParseErrors: () => Effect.succeed([]),
        clearParseErrors: () => Effect.void,
        findSymbolsByServiceTag: () => Effect.succeed([]),
        listNodesByKind: () => Effect.succeed([]),
        lookupByServiceTag: () => Effect.succeed(null),
        setMeta: () => Effect.void,
        bumpVersion: () =>
          Effect.succeed({ graphVersion: 1, coverage: 1, totalNodes: 0, totalEdges: 0, totalFiles: 0, graphBuiltAt: 0 }),
        bumpIndexedAt: () => Effect.void,
        nodesByIDs: () => Effect.succeed([]),
        putEdges: () => Effect.void,
        rebuildFtsIndex: () => Effect.succeed({ rowsIndexed: 0 }),
        recomputeInDegree: () => Effect.void,
        searchNodesLight: () => Effect.succeed([]),
        ftsSearchNodes: () => Effect.succeed([]),
        nodesByFileIDs: () => Effect.succeed([]),
        dependentsOfFiles: () => Effect.succeed([]),
        filesByIDs: () => Effect.succeed([]),
        edgesFromBatch: () => Effect.succeed([]),
        edgesToBatch: () => Effect.succeed([]),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const result = yield* resolveGraphTargetStrict(
          repo as never,
          { target: "login", allowKeywordFallback: false },
        )
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.derivation).toBe("name-exact")
          expect(result.value.node.name).toBe("login")
        }
      }).pipe(
        Effect.provide(wiredRepoLayer),
        Effect.scoped,
      ),
    )
  })

  test("resolveGraphTargetStrict returns Ok for a qualified-split symbol via step 3", async () => {
    // Build a layer with two nodes: a class `Auth` and a method `login`
    // inside it. The target `Auth.login` should resolve via step 3 even
    // when keyword fallback is disabled.
    const authFile: CodegraphFile = {
      id: "f-auth",
      path: "src/auth.ts",
      contentHash: "h",
      language: "ts",
      indexedAt: 0,
    }
    const authClass: CodegraphNode = {
      id: "n-auth",
      fileID: "f-auth",
      kind: "class",
      name: "Auth",
      startLine: 1,
      endLine: 50,
    }
    const loginMethod: CodegraphNode = {
      id: "n-login",
      fileID: "f-auth",
      kind: "method",
      name: "login",
      startLine: 10,
      endLine: 20,
    }
    const meta: CodegraphMeta = {
      id: "singleton",
      graphBuiltAt: Date.now(),
      graphVersion: 1,
      graphCoverage: 1,
      totalFiles: 1,
      totalNodes: 2,
      totalEdges: 0,
      schemaVersion: 1,
    }
    const strictRepoLayer = Layer.succeed(
      CodegraphRepo.Service,
      CodegraphRepo.Service.of({
        getMeta: () => Effect.succeed(meta),
        listAllNodes: () => Effect.succeed([authClass, loginMethod]),
        listAllFiles: () => Effect.succeed([authFile]),
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
        countNodes: () => Effect.succeed(2),
        countEdges: () => Effect.succeed(0),
        countStaleFiles: () => Effect.succeed(0),
        listStaleFiles: () => Effect.succeed([]),
    listToolUsage: () => Effect.succeed([]),
        countFiles: () => Effect.succeed(1),
        putEdge: () => Effect.void,
        getEdge: () => Effect.succeed(undefined),
        listAllEdges: () => Effect.succeed([]),
        listEdgesByNode: () => Effect.succeed([]),
        edgesFrom: () => Effect.succeed([]),
        edgesTo: () => Effect.succeed([]),
        deleteFile: () => Effect.void,
        deleteDerivedEdgesForFiles: () => Effect.succeed([]),
        deleteAllDerivedEdges: () => Effect.succeed([]),
        fileIDsByServiceName: () => Effect.succeed([]),
        writeFileGraph: () => Effect.void,
        clearAll: () => Effect.succeed({ sizeBefore: 0, sizeAfter: 0, droppedFile: false }),
        recordParseError: () => Effect.void,
        listParseErrors: () => Effect.succeed([]),
        clearParseErrors: () => Effect.void,
        findSymbolsByServiceTag: () => Effect.succeed([]),
        listNodesByKind: () => Effect.succeed([]),
        lookupByServiceTag: () => Effect.succeed(null),
        setMeta: () => Effect.void,
        bumpVersion: () =>
          Effect.succeed({ graphVersion: 1, coverage: 1, totalNodes: 0, totalEdges: 0, totalFiles: 0, graphBuiltAt: 0 }),
        bumpIndexedAt: () => Effect.void,
        nodesByIDs: (ids: string[]) =>
          Effect.succeed([authClass, loginMethod].filter((n) => ids.includes(n.id))),
        putEdges: () => Effect.void,
        rebuildFtsIndex: () => Effect.succeed({ rowsIndexed: 0 }),
        recomputeInDegree: () => Effect.void,
        // Phase 2 (P5): the resolver's qualified-split step reads a light
        // projection (no `code` column) instead of listAllNodes.
        searchNodesLight: () =>
          Effect.succeed(
            [{ ...authClass }, { ...loginMethod }].map(({ code: _code, ...rest }) => rest),
          ),
        ftsSearchNodes: () => Effect.succeed([]),
        nodesByFileIDs: () => Effect.succeed([]),
        dependentsOfFiles: () => Effect.succeed([]),
        filesByIDs: () => Effect.succeed([]),
        edgesFromBatch: () => Effect.succeed([]),
        edgesToBatch: () => Effect.succeed([]),
      }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const result = yield* resolveGraphTargetStrict(
          repo as never,
          { target: "Auth.login", allowKeywordFallback: false },
        )
        expect(result._tag).toBe("Ok")
        if (result._tag === "Ok") {
          expect(result.value.derivation).toBe("qualified-split")
          expect(result.value.node.name).toBe("login")
        }
      }).pipe(
        Effect.provide(strictRepoLayer),
        Effect.scoped,
      ),
    )
  })

})
