import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const seedFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    yield* repo.putFile({ id: "file-1", path: "src/math.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
    yield* repo.putFile({ id: "file-2", path: "src/calc.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
    yield* repo.putFile({ id: "file-3", path: "src/logger.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })
    yield* repo.putFile({ id: "file-4", path: "src/process.ts", contentHash: "h4", language: "typescript", indexedAt: 4 })
    yield* repo.putFile({ id: "file-5", path: "test/process-data.test.ts", contentHash: "h5", language: "typescript", indexedAt: 5 })
    yield* repo.putFile({ id: "file-search", path: "src/search-service.ts", contentHash: "h6", language: "typescript", indexedAt: 6 })
    yield* repo.putFile({ id: "file-indexer", path: "packages/core/src/banyancode/codegraph-indexer.ts", contentHash: "h7", language: "typescript", indexedAt: 7 })
    yield* repo.putFile({ id: "file-readme", path: "README.md", contentHash: "h8", language: "markdown", indexedAt: 8 })
    yield* repo.putFile({ id: "file-pkg", path: "package.json", contentHash: "h9", language: "json", indexedAt: 9 })

    yield* repo.putNode({ id: "cls-mathutil", fileID: "file-1", kind: "class", name: "MathUtil", signature: "class MathUtil", startLine: 1, endLine: 10, code: "class MathUtil {}" })
    yield* repo.putNode({ id: "method-add", fileID: "file-1", kind: "method", name: "add", signature: "add(a: number, b: number)", startLine: 3, endLine: 7, code: "add(a, b) {}" })
    yield* repo.putNode({ id: "fn-calculate", fileID: "file-2", kind: "function", name: "calculate", signature: "calculate(x: number)", startLine: 1, endLine: 5, code: "function calculate(x) {}" })
    yield* repo.putNode({ id: "cls-logger", fileID: "file-3", kind: "class", name: "Logger", signature: "class Logger", startLine: 1, endLine: 8, code: "class Logger {}" })
    yield* repo.putNode({ id: "method-log", fileID: "file-3", kind: "method", name: "log", signature: "log(msg: string)", startLine: 3, endLine: 6, code: "log(msg) {}" })
    yield* repo.putNode({ id: "fn-processData", fileID: "file-4", kind: "function", name: "processData", signature: "processData(input: string)", startLine: 1, endLine: 12, code: "function processData(input) {}" })
    yield* repo.putNode({ id: "test-processData", fileID: "file-5", kind: "function", name: "processDataTest", signature: "processDataTest()", startLine: 1, endLine: 20, code: "function processDataTest() {}" })
    yield* repo.putNode({ id: "cls-search", fileID: "file-search", kind: "class", name: "Search.Service", signature: "class Search.Service", startLine: 1, endLine: 50, code: "class Search.Service {}" })
    yield* repo.putNode({ id: "cls-indexer", fileID: "file-indexer", kind: "class", name: "Indexer", signature: "class Indexer", startLine: 1, endLine: 80, code: "class Indexer {}" })
    yield* repo.putNode({ id: "method-build", fileID: "file-indexer", kind: "method", name: "build", signature: "build()", startLine: 10, endLine: 60, code: "build() {}" })

    yield* repo.putEdge({ id: "e1", fromNodeID: "fn-calculate", toNodeID: "method-add", kind: "calls" })
    yield* repo.putEdge({ id: "e2", fromNodeID: "fn-processData", toNodeID: "method-log", kind: "calls" })
    yield* repo.putEdge({ id: "e3", fromNodeID: "fn-processData", toNodeID: "fn-calculate", kind: "calls" })
    yield* repo.putEdge({ id: "e4", fromNodeID: "test-processData", toNodeID: "fn-processData", kind: "references" })
    yield* repo.putEdge({ id: "e5", fromNodeID: "cls-search", toNodeID: "cls-indexer", kind: "imports" })
  })

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("RepositoryIntelligence", () => {
  test("query returns RepositoryContext with non-empty graph.nodes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const ctx = yield* ri.query({ query: "calculate" })
        expect(Array.isArray(ctx.graph.nodes)).toBe(true)
        expect(ctx.graph.nodes.length).toBeGreaterThan(0)
        expect(ctx.query).toBe("calculate")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("query + slice returns ArchitecturalSlice with summary matching the query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const ctx = yield* ri.query({ query: "processData" })
        const slc = yield* ri.slice(ctx)
        expect(slc.summary.length).toBeGreaterThan(0)
        expect(slc.summary).toContain("processData")
        expect(Array.isArray(slc.entrypoints)).toBe(true)
        expect(Array.isArray(slc.importantSymbols)).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain returns ArchitecturalSlice with entrypoints.length > 0", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const slc = yield* ri.explain({ symbol: "Search.Service" })
        expect(slc.entrypoints.length).toBeGreaterThan(0)
        expect(slc.entrypoints.some((n) => n.name === "Search.Service")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("impact returns ArchitecturalSlice with importantSymbols.length > 0", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const slc = yield* ri.impact({ path: "packages/core/src/banyancode/codegraph-indexer.ts" })
        expect(slc.importantSymbols.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findOwner returns owner/count pair or empty when git missing", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.findOwner({ path: "anywhere" })
        expect(typeof result.count).toBe("number")
        if (result.owner === undefined) {
          expect(result.count).toBe(0)
        } else {
          expect(typeof result.owner).toBe("string")
          expect(result.count).toBeGreaterThanOrEqual(0)
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("query + slice for an unknown query returns slice with empty best-effort fields and non-empty summary", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const ctx = yield* ri.query({ query: "definitely-not-in-fixture-xyz" })
        const slc = yield* ri.slice(ctx)
        expect(slc.summary.length).toBeGreaterThan(0)
        expect(slc.entrypoints).toEqual([])
        expect(slc.importantSymbols).toEqual([])
        expect(slc.routes).toEqual([])
        expect(slc.dependencies).toEqual([])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("tests returns test nodes referencing the symbol", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.tests({ symbol: "processData" })
        expect(results.length).toBeGreaterThan(0)
        expect(results.some((n) => n.name === "processDataTest")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("symbols returns nodes matching the query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.symbols({ query: "calculate" })
        expect(results.length).toBeGreaterThan(0)
        expect(results.some((n) => n.name === "calculate")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("relationships returns nodes reachable via graph edges", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.relationships({ nodeID: "fn-processData", depth: 1 })
        const names = results.map((n) => n.name).sort()
        expect(names).toContain("calculate")
        expect(names).toContain("log")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace returns ArchitecturalSlice from a symbol anchor", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const slc = yield* ri.trace({ symbol: "processData", depth: 2 })
        expect(slc.summary.length).toBeGreaterThan(0)
        expect(slc.entrypoints.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("query with dot-notation parses Class.method correctly", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.symbols({ query: "MathUtil.add" })
        expect(results.length).toBeGreaterThan(0)
        expect(results[0].name).toBe("add")
        expect(results[0].fileID).toBe("file-1")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("query for unknown symbol returns degraded status with empty docs and configs", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const ctx = yield* ri.query({ query: "NonExistentClass.method" })
        expect(ctx.status).toBe("failed")
        expect(ctx.degraded).toBe(true)
        expect(ctx.docs).toEqual([])
        expect(ctx.configs).toEqual([])
        expect(ctx.files).toEqual([])
        expect(ctx.reason).toContain("No matching symbols found")
        expect(ctx.recoveryHint).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})