import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

// Set BANYANCODE_ENABLE for all tests
process.env.BANYANCODE_ENABLE = "1"

// Fixture: 5 files with functions, classes, imports between them:
// file-1: Class "MathUtil" with method "add"
// file-2: Function "calculate" that calls "add"
// file-3: Class "Logger" with method "log"
// file-4: Function "processData" that uses "Logger.log" and "calculate"
// file-5: test/process-data.test.ts that references "processData"

const seedFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    // Files
    yield* repo.putFile({ id: "file-1", path: "src/math.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
    yield* repo.putFile({ id: "file-2", path: "src/calc.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
    yield* repo.putFile({ id: "file-3", path: "src/logger.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })
    yield* repo.putFile({ id: "file-4", path: "src/process.ts", contentHash: "h4", language: "typescript", indexedAt: 4 })
    yield* repo.putFile({ id: "file-5", path: "test/process-data.test.ts", contentHash: "h5", language: "typescript", indexedAt: 5 })

    // Nodes
    yield* repo.putNode({ id: "cls-mathutil", fileID: "file-1", kind: "class", name: "MathUtil", signature: "class MathUtil", startLine: 1, endLine: 10, code: "class MathUtil {}" })
    yield* repo.putNode({ id: "method-add", fileID: "file-1", kind: "method", name: "add", signature: "add(a: number, b: number)", startLine: 3, endLine: 7, code: "add(a, b) {}" })
    yield* repo.putNode({ id: "fn-calculate", fileID: "file-2", kind: "function", name: "calculate", signature: "calculate(x: number)", startLine: 1, endLine: 5, code: "function calculate(x) {}" })
    yield* repo.putNode({ id: "cls-logger", fileID: "file-3", kind: "class", name: "Logger", signature: "class Logger", startLine: 1, endLine: 8, code: "class Logger {}" })
    yield* repo.putNode({ id: "method-log", fileID: "file-3", kind: "method", name: "log", signature: "log(msg: string)", startLine: 3, endLine: 6, code: "log(msg) {}" })
    yield* repo.putNode({ id: "fn-processData", fileID: "file-4", kind: "function", name: "processData", signature: "processData(input: string)", startLine: 1, endLine: 12, code: "function processData(input) {}" })
    yield* repo.putNode({ id: "test-processData", fileID: "file-5", kind: "function", name: "processDataTest", signature: "processDataTest()", startLine: 1, endLine: 20, code: "function processDataTest() {}" })

    // Edges
    yield* repo.putEdge({ id: "e1", fromNodeID: "fn-calculate", toNodeID: "method-add", kind: "calls" })
    yield* repo.putEdge({ id: "e2", fromNodeID: "fn-processData", toNodeID: "method-log", kind: "calls" })
    yield* repo.putEdge({ id: "e3", fromNodeID: "fn-processData", toNodeID: "fn-calculate", kind: "calls" })
    yield* repo.putEdge({ id: "e4", fromNodeID: "test-processData", toNodeID: "fn-processData", kind: "references" })
  })

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("RepositoryIntelligence", () => {
  // ------------------------------------------------------------------
  // findSymbol
  // ------------------------------------------------------------------
  test("findSymbol returns nodes matching name", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.findSymbol({ name: "calculate" })
        expect(results.length).toBeGreaterThan(0)
        expect(results.some((n) => n.name === "calculate")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findSymbol filters by kind", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const classes = yield* ri.findSymbol({ name: "Logger", kind: "class" })
        expect(classes.length).toBe(1)
        expect(classes[0].name).toBe("Logger")
        expect(classes[0].kind).toBe("class")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findSymbol with exact returns exact name matches only", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const exact = yield* ri.findSymbol({ name: "calculate", exact: true })
        expect(exact.length).toBe(1)
        expect(exact[0].name).toBe("calculate")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // ------------------------------------------------------------------
  // findSubsystem
  // ------------------------------------------------------------------
  test("findSubsystem returns entry and related nodes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.findSubsystem({ query: "processData" })
        expect(result.entry.name).toBe("processData")
        expect(Array.isArray(result.related)).toBe(true)
        const relatedNames = result.related.map((n) => n.name).sort()
        expect(relatedNames).toContain("calculate")
        expect(relatedNames).toContain("log")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findSubsystem respects maxDepth", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const depth0 = yield* ri.findSubsystem({ query: "processData", maxDepth: 0 })
        expect(depth0.related.length).toBe(0)

        const depth1 = yield* ri.findSubsystem({ query: "processData", maxDepth: 1 })
        expect(depth1.related.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // ------------------------------------------------------------------
  // findEntrypoints
  // ------------------------------------------------------------------
  test("findEntrypoints returns functions and classes from files matching feature name", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.findEntrypoints({ feature: "process" })
        const names = results.map((n) => n.name).sort()
        expect(names).toContain("processData")
        expect(names).toContain("processDataTest")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findEntrypoints returns empty array for unknown feature", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.findEntrypoints({ feature: "nonexistent-feature-xyz" })
        expect(results).toEqual([])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // ------------------------------------------------------------------
  // findTests
  // ------------------------------------------------------------------
  test("findTests returns test nodes referencing the symbol", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.findTests({ symbol: "processData" })
        expect(results.length).toBe(1)
        expect(results[0].name).toBe("processDataTest")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findTests returns empty for symbol with no test", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.findTests({ symbol: "add" })
        expect(results).toEqual([])
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // ------------------------------------------------------------------
  // findRelated
  // ------------------------------------------------------------------
  test("findRelated returns nodes reachable via edges", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.findRelated({ nodeID: "fn-processData" })
        const names = results.map((n) => n.name).sort()
        expect(names).toContain("calculate")
        expect(names).toContain("log")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findRelated respects depth parameter", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const depth0 = yield* ri.findRelated({ nodeID: "fn-processData", depth: 0 })
        expect(depth0).toEqual([])

        const depth1 = yield* ri.findRelated({ nodeID: "fn-processData", depth: 1 })
        expect(depth1.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // ------------------------------------------------------------------
  // estimateImpact
  // ------------------------------------------------------------------
  test("estimateImpact returns direct and transitive callers with blastRadius", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.estimateImpact({ paths: ["src/process.ts"], maxDepth: 1 })
        expect(result.direct.length).toBe(1)
        expect(result.direct[0].name).toBe("processData")
        expect(result.transitive.length).toBeGreaterThan(0)
        expect(typeof result.blastRadius).toBe("number")
        expect(result.blastRadius).toBeGreaterThanOrEqual(0)
        expect(result.blastRadius).toBeLessThanOrEqual(1)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("estimateImpact returns empty for unknown path", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const result = yield* ri.estimateImpact({ paths: ["nonexistent/file.ts"] })
        expect(result.direct).toEqual([])
        expect(result.transitive).toEqual([])
        expect(result.blastRadius).toBe(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  // ------------------------------------------------------------------
  // traceExecution
  // ------------------------------------------------------------------
  test("traceExecution follows calls and imports edges forward", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.traceExecution({ from: "fn-processData" })
        const names = results.map((n) => n.name).sort()
        expect(names).toContain("calculate")
        expect(names).toContain("log")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("traceExecution respects maxDepth (default 4)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const ri = yield* RepositoryIntelligence.Service

        const results = yield* ri.traceExecution({ from: "fn-processData", maxDepth: 0 })
        expect(results).toEqual([])

        const results2 = yield* ri.traceExecution({ from: "fn-processData", maxDepth: 1 })
        expect(results2.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
