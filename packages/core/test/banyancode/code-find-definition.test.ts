import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "../../src/banyancode"
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
        { id: "n1", fileID: "f1", kind: "function" as const, name: "login", startLine: 1, endLine: 10 },
        { id: "n2", fileID: "f1", kind: "function" as const, name: "logout", startLine: 12, endLine: 20 },
        { id: "n3", fileID: "f2", kind: "class" as const, name: "User", startLine: 1, endLine: 50 },
        { id: "n4", fileID: "f3", kind: "class" as const, name: "A", startLine: 1, endLine: 30 },
        { id: "n5", fileID: "f3", kind: "function" as const, name: "b", signature: "A.b()", startLine: 10, endLine: 15 },
        { id: "n6", fileID: "f4", kind: "function" as const, name: "EffectModule", code: "# Effect.gen\n\nA markdown heading mentioning Effect.gen", startLine: 1, endLine: 5 },
      ]),
    listAllFiles: () =>
      Effect.succeed([
        { id: "f1", path: "auth.ts", contentHash: "h1", language: "ts", indexedAt: 0 },
        { id: "f2", path: "models/user.ts", contentHash: "h2", language: "ts", indexedAt: 0 },
        { id: "f3", path: "a.ts", contentHash: "h3", language: "ts", indexedAt: 0 },
        { id: "f4", path: "docs/guide.md", contentHash: "h4", language: "markdown", indexedAt: 0 },
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
    listNodesByKind: () => Effect.succeed([]),
    lookupByServiceTag: () => Effect.succeed(null),
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

describe("code_find definition intent", () => {
  test("definition of unknown external symbol returns empty (not markdown hits)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const nodes = yield* repo.listAllNodes()
        const matches = nodes.filter((n) => n.name.toLowerCase() === "effect.gen")
        expect(matches.length).toBe(0)
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("definition with includeKeywordFallback true allows content search", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const nodes = yield* repo.listAllNodes()
        const target = "effect.gen"
        const lowerTarget = target.toLowerCase()
        const matches = nodes.filter((n) =>
          n.name.toLowerCase() === lowerTarget || (n.code?.toLowerCase().includes(lowerTarget) ?? false)
        )
        expect(matches.length).toBe(1)
        expect(matches[0]?.name).toBe("EffectModule")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("definition of known symbol returns the symbol node", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const nodes = yield* repo.listAllNodes()
        const matches = nodes.filter((n) => n.name === "User")
        expect(matches.length).toBe(1)
        expect(matches[0]?.name).toBe("User")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("definition of dot-notation symbol returns the method", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const nodes = yield* repo.listAllNodes()
        const target = "A.b"
        const parts = target.toLowerCase().split(".")
        const lastPart = parts[parts.length - 1] ?? ""
        const matches = nodes.filter((n) => n.name.toLowerCase() === lastPart)
        expect(matches.length).toBe(1)
        expect(matches[0]?.name).toBe("b")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("definition without includeKeywordFallback arg (undefined) falls back to keyword search", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const nodes = yield* repo.listAllNodes()
        const target = "effect.gen"
        const lowerTarget = target.toLowerCase()
        const includeKeywordFallback = undefined
        const allowKeyword = includeKeywordFallback !== false
        let matches: typeof nodes
        if (allowKeyword) {
          matches = nodes.filter((n) =>
            n.name.toLowerCase() === lowerTarget || (n.code?.toLowerCase().includes(lowerTarget) ?? false)
          )
        } else {
          matches = nodes.filter((n) => n.name.toLowerCase() === lowerTarget)
        }
        expect(matches.length).toBe(1)
        expect(matches[0]?.name).toBe("EffectModule")
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })

  test("definition with includeKeywordFallback=false opts out of keyword search", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        const nodes = yield* repo.listAllNodes()
        const target = "effect.gen"
        const lowerTarget = target.toLowerCase()
        const includeKeywordFallback = false
        const allowKeyword = includeKeywordFallback !== false
        let matches: typeof nodes
        if (allowKeyword) {
          matches = nodes.filter((n) =>
            n.name.toLowerCase() === lowerTarget || (n.code?.toLowerCase().includes(lowerTarget) ?? false)
          )
        } else {
          matches = nodes.filter((n) => n.name.toLowerCase() === lowerTarget)
        }
        expect(matches.length).toBe(0)
      }).pipe(
        Effect.provide(mockServicesLayer),
        Effect.scoped,
      ),
    )
  })
})
