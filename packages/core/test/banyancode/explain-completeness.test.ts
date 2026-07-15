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

describe("explain completeness", () => {
  test("explain with one anchor + incoming calls edge → directCallers contains the calling node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f1", path: "src/utils.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f2", path: "src/consumer.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "n-util", fileID: "f1", kind: "function", name: "helper", signature: "helper()", startLine: 1, endLine: 5, code: "function helper() {}" })
        yield* repo.putNode({ id: "n-caller", fileID: "f2", kind: "function", name: "caller", signature: "caller()", startLine: 1, endLine: 10, code: "function caller() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-caller", toNodeID: "n-util", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.explain({ symbol: "helper" })

        expect(result.directCallers.map((n) => n.id)).toContain("n-caller")
        expect(result.dependencies.some((d) => d.name === "caller")).toBe(false)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain with one anchor + imports edge → imported module name in dependencies, NOT in directCallers", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f1", path: "src/consumer.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f2", path: "lib/external.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "n-consumer", fileID: "f1", kind: "function", name: "consume", signature: "consume()", startLine: 1, endLine: 5, code: "function consume() {}" })
        yield* repo.putNode({ id: "n-lib", fileID: "f2", kind: "class", name: "ExternalLib", signature: "class ExternalLib", startLine: 1, endLine: 20, code: "class ExternalLib {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-consumer", toNodeID: "n-lib", kind: "imports" })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.explain({ symbol: "consume" })

        expect(result.directCallers.map((n) => n.id)).not.toContain("n-lib")
        expect(result.dependencies.some((d) => d.name === "ExternalLib")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain with extends edge → parent class NOT in directCallers, appears in dependencies", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f1", path: "src/base.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f2", path: "src/child.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "n-base", fileID: "f1", kind: "class", name: "Base", signature: "class Base", startLine: 1, endLine: 10, code: "class Base {}" })
        yield* repo.putNode({ id: "n-child", fileID: "f2", kind: "class", name: "Child", signature: "class Child extends Base", startLine: 1, endLine: 15, code: "class Child extends Base {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-child", toNodeID: "n-base", kind: "extends" })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.explain({ symbol: "Child" })

        expect(result.directCallers.map((n) => n.id)).not.toContain("n-base")
        expect(result.dependencies.some((d) => d.name === "Base")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain with tested_by edge → test node NOT in directCallers or dependencies", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f1", path: "src/math.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f2", path: "test/math.test.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "n-math", fileID: "f1", kind: "function", name: "add", signature: "add(a,b)", startLine: 1, endLine: 5, code: "function add(a,b) {}" })
        yield* repo.putNode({ id: "n-test", fileID: "f2", kind: "function", name: "addTest", signature: "addTest()", startLine: 1, endLine: 20, code: "function addTest() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-test", toNodeID: "n-math", kind: "tested_by" })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.explain({ symbol: "add" })

        expect(result.directCallers.map((n) => n.id)).not.toContain("n-test")
        expect(result.dependencies.some((d) => d.name === "addTest")).toBe(false)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain bounds output → with 30 incoming callers, directCallers.length <= 25 and moreAvailable.callers >= 5", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-target", path: "src/target.ts", contentHash: "h0", language: "typescript", indexedAt: 0 })
        yield* repo.putNode({ id: "n-target", fileID: "f-target", kind: "function", name: "target", signature: "target()", startLine: 1, endLine: 5, code: "function target() {}" })

        for (let i = 1; i <= 30; i++) {
          const fid = `f-caller-${i}`
          const nid = `n-caller-${i}`
          yield* repo.putFile({ id: fid, path: `src/caller-${i}.ts`, contentHash: `h${i}`, language: "typescript", indexedAt: i })
          yield* repo.putNode({ id: nid, fileID: fid, kind: "function", name: `caller${i}`, signature: `caller${i}()`, startLine: 1, endLine: 5, code: `function caller${i}() {}` })
          yield* repo.putEdge({ id: `e-${i}`, fromNodeID: nid, toNodeID: "n-target", kind: "calls" })
        }

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.explain({ symbol: "target" })

        expect(result.directCallers.length).toBeLessThanOrEqual(25)
        expect(result.moreAvailable?.callers ?? 0).toBeGreaterThanOrEqual(5)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("explain with no matching symbol → returns empty directCallers, transitiveDependents, dependencies", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f1", path: "src/math.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n-math", fileID: "f1", kind: "function", name: "add", signature: "add(a,b)", startLine: 1, endLine: 5, code: "function add(a,b) {}" })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.explain({ symbol: "nonexistent-symbol-xyz" })

        expect(result.directCallers).toHaveLength(0)
        expect(result.transitiveDependents).toHaveLength(0)
        expect(result.dependencies).toHaveLength(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
