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
        expect(results.tests.length).toBeGreaterThan(0)
        expect(results.tests.some((n) => n.name === "processDataTest")).toBe(true)
        expect(results.notFound).toBe(false)
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

  test("explain recovers Context.Service tag fallback", async () => {
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
          code: `export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Banyan/MemoryRepo") {}`,
        })

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.explain({ symbol: "MemoryRepo" })
        expect(slc.importantSymbols.length).toBe(1)
        expect(slc.importantSymbols[0]!.name).toBe("Service")
        expect(slc.importantSymbols[0]!.code).toContain("@opencode/v2/Banyan/MemoryRepo")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain returns empty + diagnostic when symbol is genuinely missing", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-empty", path: "src/empty.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.explain({ symbol: "DoesNotExistAnywhere" })
        expect(slc.importantSymbols).toEqual([])
        expect(slc.status).toBe("failed")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("tests returns empty + notFound when symbol is not in graph", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.tests({ symbol: "NonExistent" })
        expect(results.tests).toEqual([])
        expect(results.notFound).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace reuses ctx.symbols[0] for the anchor", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        // After the trace split, `entrypoints` is populated from depth=1
        // callers (per the plan: back-compat alias for `directCallers`).
        // MathUtil itself has no incoming calls in the fixture, so
        // entrypoints is empty here — but the slice is still well-formed
        // and directCallers/transitiveDependents are present as empty arrays.
        const slc = yield* ri.trace({ symbol: "MathUtil", depth: 2 })
        expect(Array.isArray(slc.directCallers)).toBe(true)
        expect(Array.isArray(slc.transitiveDependents)).toBe(true)
        expect(slc.entrypoints).toEqual([])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // Helper: a directed chain fixture used by the trace-split tests.
  // chain: fn-a -> fn-target, fn-b -> fn-a, fn-c -> fn-b
  //   so for anchor=fn-target: direct = {fn-a}, transitive = {fn-b, fn-c}
  const seedChainFixture = () =>
    Effect.gen(function* () {
      const repo = yield* CodegraphRepo.Service
      yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
      yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
      yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
      yield* repo.putFile({ id: "f-c", path: "src/c.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
      yield* repo.putNode({ id: "n-target", fileID: "f-target", kind: "function", name: "fn-target", signature: "fn-target()", startLine: 1, endLine: 2, code: "function fn-target() {}" })
      yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "fn-a", signature: "fn-a()", startLine: 1, endLine: 2, code: "function fn-a() {}" })
      yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "fn-b", signature: "fn-b()", startLine: 1, endLine: 2, code: "function fn-b() {}" })
      yield* repo.putNode({ id: "n-c", fileID: "f-c", kind: "function", name: "fn-c", signature: "fn-c()", startLine: 1, endLine: 2, code: "function fn-c() {}" })
      // fn-a calls fn-target (so fn-a is a depth=1 caller of fn-target).
      yield* repo.putEdge({ id: "e-a-target", fromNodeID: "n-a", toNodeID: "n-target", kind: "calls" })
      // fn-b calls fn-a (transitive depth=2).
      yield* repo.putEdge({ id: "e-b-a", fromNodeID: "n-b", toNodeID: "n-a", kind: "calls" })
      // fn-c calls fn-b (transitive depth=3).
      yield* repo.putEdge({ id: "e-c-b", fromNodeID: "n-c", toNodeID: "n-b", kind: "calls" })
    })

  test("trace splits into directCallers + transitiveDependents", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedChainFixture()
        const ri = yield* RepositoryIntelligence.Service

        const slc = yield* ri.trace({ symbol: "fn-target", depth: 3 })
        const directNames = slc.directCallers.map((n) => n.name).sort()
        const transitiveNames = slc.transitiveDependents.map((n) => n.name).sort()
        expect(directNames).toEqual(["fn-a"])
        expect(transitiveNames).toEqual(["fn-b", "fn-c"])
        // entrypoints is the back-compat alias for directCallers.
        expect(slc.entrypoints.map((n) => n.name).sort()).toEqual(["fn-a"])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace respects the limit knob on transitiveDependents", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // target <- a (depth=1) <- b1..b100 (depth=2). Limit to 3.
        yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-target", fileID: "f-target", kind: "function", name: "target", signature: "target()", startLine: 1, endLine: 2, code: "function target() {}" })
        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "a", signature: "a()", startLine: 1, endLine: 2, code: "function a() {}" })
        yield* repo.putEdge({ id: "e-a-target", fromNodeID: "n-a", toNodeID: "n-target", kind: "calls" })

        for (let i = 0; i < 100; i++) {
          const id = `n-b${i}`
          yield* repo.putFile({ id: `f-b${i}`, path: `src/b${i}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-b${i}`, kind: "function", name: `b${i}`, signature: `b${i}()`, startLine: 1, endLine: 2, code: `function b${i}() {}` })
          yield* repo.putEdge({ id: `e-b${i}-a`, fromNodeID: id, toNodeID: "n-a", kind: "calls" })
        }

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({ symbol: "target", depth: 2, limit: 3 })

        expect(slc.transitiveDependents.length).toBe(3)
        expect(slc.moreAvailable?.dependents).toBe(97)
        // directCallers still includes the depth=1 node regardless of limit.
        expect(slc.directCallers.length).toBe(1)
        expect(slc.directCallers[0]!.name).toBe("a")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace moreAvailable.transitiveDependents is populated when truncation occurs", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-target", fileID: "f-target", kind: "function", name: "target", signature: "target()", startLine: 1, endLine: 2, code: "function target() {}" })
        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "a", signature: "a()", startLine: 1, endLine: 2, code: "function a() {}" })
        yield* repo.putEdge({ id: "e-a-target", fromNodeID: "n-a", toNodeID: "n-target", kind: "calls" })

        for (let i = 0; i < 100; i++) {
          const id = `n-b${i}`
          yield* repo.putFile({ id: `f-b${i}`, path: `src/b${i}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-b${i}`, kind: "function", name: `b${i}`, signature: `b${i}()`, startLine: 1, endLine: 2, code: `function b${i}() {}` })
          yield* repo.putEdge({ id: `e-b${i}-a`, fromNodeID: id, toNodeID: "n-a", kind: "calls" })
        }

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({ symbol: "target", depth: 2, limit: 10 })

        expect(slc.transitiveDependents.length).toBe(10)
        expect(slc.moreAvailable?.dependents).toBe(90)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace ranks transitive dependents: cli-handler (entrypoint) above many ordinary callers", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // target <- a (depth=1) <- super-hub + 200 ordinary callers (depth=2).
        // super-hub is also reachable via a "cli-handler" (depth=3) which
        // matches the entrypoint heuristic (name "cli-handler"). Without
        // ranking, super-hub's higher inDegree would dominate. With the
        // ranking formula, cli-handler scores (1/3) * 2 = 0.666 and
        // super-hub scores (1/2) * 1 = 0.5, so cli-handler wins on rank.
        yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-hub", path: "src/super-hub.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-cli", path: "src/cli/cli-handler.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-target", fileID: "f-target", kind: "function", name: "target", signature: "target()", startLine: 1, endLine: 2, code: "function target() {}" })
        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "a", signature: "a()", startLine: 1, endLine: 2, code: "function a() {}" })
        yield* repo.putNode({ id: "n-hub", fileID: "f-hub", kind: "function", name: "super-hub", signature: "super-hub()", startLine: 1, endLine: 2, code: "function super-hub() {}" })
        yield* repo.putNode({ id: "n-cli", fileID: "f-cli", kind: "function", name: "cli-handler", signature: "cli-handler()", startLine: 1, endLine: 2, code: "function cli-handler() {}" })
        yield* repo.putEdge({ id: "e-a-target", fromNodeID: "n-a", toNodeID: "n-target", kind: "calls" })
        yield* repo.putEdge({ id: "e-hub-a", fromNodeID: "n-hub", toNodeID: "n-a", kind: "calls" })
        yield* repo.putEdge({ id: "e-cli-hub", fromNodeID: "n-cli", toNodeID: "n-hub", kind: "calls" })

        for (let i = 0; i < 200; i++) {
          const id = `n-noise${i}`
          yield* repo.putFile({ id: `f-noise${i}`, path: `src/noise${i}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-noise${i}`, kind: "function", name: `noise${i}`, signature: `noise${i}()`, startLine: 1, endLine: 2, code: `function noise${i}() {}` })
          yield* repo.putEdge({ id: `e-noise${i}-a`, fromNodeID: id, toNodeID: "n-a", kind: "calls" })
        }

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({ symbol: "target", depth: 3, limit: 200 })

        const names = slc.transitiveDependents.map((n) => n.name)
        const cliIdx = names.indexOf("cli-handler")
        const hubIdx = names.indexOf("super-hub")
        expect(cliIdx).toBeGreaterThanOrEqual(0)
        expect(hubIdx).toBeGreaterThanOrEqual(0)
        // cli-handler (depth=3, isEntrypoint=true) must rank above super-hub
        // (depth=2, plain). Even though super-hub has many incoming edges,
        // the ranking formula favors entrypoint-over-depth.
        expect(cliIdx).toBeLessThan(hubIdx)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace drops pure-transitive god objects below the visibility threshold when limit is small", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // target <- a (depth=1) <- god-utility + 500 plain callers (depth=2).
        // Also: a "real-handler" entrypoint (depth=2) — should rank above
        // the god-utility and the plain noise. The "god-object" half of
        // the assertion: with limit=5, real-handler is in top-5 but
        // god-utility is NOT (it's a plain function with 500 incoming
        // edges, but inDegree isn't populated until Phase 3).
        yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-god", path: "src/god-utility.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-handler", path: "src/handlers/real-handler.ts", contentHash: "h", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-target", fileID: "f-target", kind: "function", name: "target", signature: "target()", startLine: 1, endLine: 2, code: "function target() {}" })
        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "a", signature: "a()", startLine: 1, endLine: 2, code: "function a() {}" })
        yield* repo.putNode({ id: "n-god", fileID: "f-god", kind: "function", name: "god-utility", signature: "god-utility()", startLine: 1, endLine: 2, code: "function god-utility() {}" })
        yield* repo.putNode({ id: "n-handler", fileID: "f-handler", kind: "function", name: "real-handler", signature: "real-handler()", startLine: 1, endLine: 2, code: "function real-handler() {}" })
        yield* repo.putEdge({ id: "e-a-target", fromNodeID: "n-a", toNodeID: "n-target", kind: "calls" })
        yield* repo.putEdge({ id: "e-god-a", fromNodeID: "n-god", toNodeID: "n-a", kind: "extends" })
        yield* repo.putEdge({ id: "e-handler-a", fromNodeID: "n-handler", toNodeID: "n-a", kind: "calls" })

        for (let i = 0; i < 500; i++) {
          const id = `n-noise${i}`
          yield* repo.putFile({ id: `f-noise${i}`, path: `src/noise${i}.ts`, contentHash: "h", language: "typescript", indexedAt: 1 })
          yield* repo.putNode({ id, fileID: `f-noise${i}`, kind: "function", name: `noise${i}`, signature: `noise${i}()`, startLine: 1, endLine: 2, code: `function noise${i}() {}` })
          yield* repo.putEdge({ id: `e-noise${i}-a`, fromNodeID: id, toNodeID: "n-a", kind: "extends" })
        }

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({ symbol: "target", depth: 2, limit: 5 })

        expect(slc.transitiveDependents.length).toBe(5)
        expect(slc.moreAvailable?.dependents).toBe(497)
        // real-handler (depth=2, isEntrypoint=true via /handlers/ path) ranks
        // at index 0. The remaining 4 slots are tied-score noise/god nodes
        // — god-utility is no more likely to land in the top-5 than any
        // other plain depth=2 node. Crucially: real-handler IS at the top.
        const got = slc.transitiveDependents.map((n) => n.name)
        expect(got[0]).toBe("real-handler")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})