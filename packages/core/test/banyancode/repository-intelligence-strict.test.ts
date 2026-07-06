import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("RepositoryIntelligence Strict Diagnostic Policy", () => {
  test("repository_query with non-existent symbol returns failed + diagnostic", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-1", path: "src/math.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.query({ query: "DoesNotExist" })

        expect(result.status).toBe("failed")
        expect(result.diagnostics).toBeDefined()
        expect(result.diagnostics!.length).toBeGreaterThan(0)
        expect(result.diagnostics![0]!.kind).toBe("symbol-not-found")
        expect(result.fallbackUsed).toBe(false)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("repository_explain with Context.Service tag-recovered symbol returns success + fallbackUsed=true", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-tag", path: "src/memory-repo.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({
          id: "svc-memoryrepo",
          fileID: "file-tag",
          kind: "class",
          name: "Service",
          signature: "class Service extends Context.Service<Service, Interface>()",
          startLine: 1,
          endLine: 10,
          code: `class Service extends Context.Service<Service, Interface>()("@banyancode/MemoryRepo")`,
        })

        const ri = yield* RepositoryIntelligence.Service
        const ctx = yield* ri.query({ query: "MemoryRepo" })

        expect(ctx.status).toBe("success")
        expect(ctx.fallbackUsed).toBe(true)
        expect(ctx.symbols.length).toBe(1)
        expect(ctx.symbols[0]!.name).toBe("Service")
        expect(ctx.diagnostics).toEqual([])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("repository_tests does not return substring noise", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-1", path: "src/real.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "file-test", path: "test/test_one.test.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putFile({ id: "file-test2", path: "test/test_two.test.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })
        yield* repo.putFile({ id: "file-test3", path: "test/test_three.test.ts", contentHash: "h4", language: "typescript", indexedAt: 4 })
        yield* repo.putFile({ id: "file-test4", path: "test/test_four.test.ts", contentHash: "h5", language: "typescript", indexedAt: 5 })
        yield* repo.putFile({ id: "file-test5", path: "test/test_five.test.ts", contentHash: "h6", language: "typescript", indexedAt: 6 })

        yield* repo.putNode({ id: "node-1", fileID: "file-1", kind: "class", name: "RealClass", signature: "class RealClass", startLine: 1, endLine: 10, code: "class RealClass {}" })
        yield* repo.putNode({ id: "test-1", fileID: "file-test", kind: "function", name: "test_one", signature: "test_one()", startLine: 1, endLine: 10, code: "function test_one() {}" })
        yield* repo.putNode({ id: "test-2", fileID: "file-test2", kind: "function", name: "test_two", signature: "test_two()", startLine: 1, endLine: 10, code: "function test_two() {}" })
        yield* repo.putNode({ id: "test-3", fileID: "file-test3", kind: "function", name: "test_three", signature: "test_three()", startLine: 1, endLine: 10, code: "function test_three() {}" })
        yield* repo.putNode({ id: "test-4", fileID: "file-test4", kind: "function", name: "test_four", signature: "test_four()", startLine: 1, endLine: 10, code: "function test_four() {}" })
        yield* repo.putNode({ id: "test-5", fileID: "file-test5", kind: "function", name: "test_five", signature: "test_five()", startLine: 1, endLine: 10, code: "function test_five() {}" })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.tests({ symbol: "DoesNotExist" })

        expect(result.tests.length).toBe(0)
        expect(result.notFound).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
