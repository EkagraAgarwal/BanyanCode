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

describe("Directional Traversal", () => {
  test("findCallers only follows incoming calls/references", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putFile({ id: "f-c", path: "src/c.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })

        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "A", signature: "function A()", startLine: 1, endLine: 5, code: "function A() {}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "B", signature: "function B()", startLine: 1, endLine: 5, code: "function B() {}" })
        yield* repo.putNode({ id: "n-c", fileID: "f-c", kind: "function", name: "C", signature: "function C()", startLine: 1, endLine: 5, code: "function C() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-b", toNodeID: "n-a", kind: "calls" })
        yield* repo.putEdge({ id: "e2", fromNodeID: "n-c", toNodeID: "n-a", kind: "references" })

        const ri = yield* RepositoryIntelligence.Service
        const related = yield* ri.relationships({ nodeID: "n-a", depth: 1 })

        expect(related.some((n) => n.id === "n-b")).toBe(true)
        expect(related.some((n) => n.id === "n-c")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findRelated (tolerant) follows outgoing calls as dependencies", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "A", signature: "function A()", startLine: 1, endLine: 5, code: "function A() {}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "B", signature: "function B()", startLine: 1, endLine: 5, code: "function B() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-a", toNodeID: "n-b", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const related = yield* ri.relationships({ nodeID: "n-a", depth: 1 })

        expect(related.some((n) => n.id === "n-b")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findDependencies follows outgoing calls/references/imports/extends", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putFile({ id: "f-c", path: "src/c.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })
        yield* repo.putFile({ id: "f-d", path: "src/d.ts", contentHash: "h4", language: "typescript", indexedAt: 4 })

        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "A", signature: "function A()", startLine: 1, endLine: 5, code: "function A() {}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "B", signature: "function B()", startLine: 1, endLine: 5, code: "function B() {}" })
        yield* repo.putNode({ id: "n-c", fileID: "f-c", kind: "class", name: "C", signature: "class C", startLine: 1, endLine: 5, code: "class C {}" })
        yield* repo.putNode({ id: "n-d", fileID: "f-d", kind: "class", name: "D", signature: "class D", startLine: 1, endLine: 5, code: "class D {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-a", toNodeID: "n-b", kind: "calls" })
        yield* repo.putEdge({ id: "e2", fromNodeID: "n-a", toNodeID: "n-c", kind: "imports" })
        yield* repo.putEdge({ id: "e3", fromNodeID: "n-a", toNodeID: "n-d", kind: "extends" })

        const ri = yield* RepositoryIntelligence.Service
        const related = yield* ri.relationships({ nodeID: "n-a", depth: 1 })

        expect(related.some((n) => n.id === "n-b")).toBe(true)
        expect(related.some((n) => n.id === "n-c")).toBe(true)
        expect(related.some((n) => n.id === "n-d")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findRelated (tolerant) follows incoming calls as callers", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "A", signature: "function A()", startLine: 1, endLine: 5, code: "function A() {}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "B", signature: "function B()", startLine: 1, endLine: 5, code: "function B() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-b", toNodeID: "n-a", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const related = yield* ri.relationships({ nodeID: "n-a", depth: 1 })

        expect(related.some((n) => n.id === "n-b")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("findRelated (tolerant) returns callers + dependencies", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putFile({ id: "f-c", path: "src/c.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })

        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "A", signature: "function A()", startLine: 1, endLine: 5, code: "function A() {}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "B", signature: "function B()", startLine: 1, endLine: 5, code: "function B() {}" })
        yield* repo.putNode({ id: "n-c", fileID: "f-c", kind: "function", name: "C", signature: "function C()", startLine: 1, endLine: 5, code: "function C() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-b", toNodeID: "n-a", kind: "calls" })
        yield* repo.putEdge({ id: "e2", fromNodeID: "n-c", toNodeID: "n-a", kind: "imports" })

        const ri = yield* RepositoryIntelligence.Service
        const related = yield* ri.relationships({ nodeID: "n-a", depth: 1 })

        expect(related.some((n) => n.id === "n-b")).toBe(true)
        expect(related.some((n) => n.id === "n-c")).toBe(false)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("depth limit is respected", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
        yield* repo.putFile({ id: "f-c", path: "src/c.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })

        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "A", signature: "function A()", startLine: 1, endLine: 5, code: "function A() {}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "B", signature: "function B()", startLine: 1, endLine: 5, code: "function B() {}" })
        yield* repo.putNode({ id: "n-c", fileID: "f-c", kind: "function", name: "C", signature: "function C()", startLine: 1, endLine: 5, code: "function C() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-b", toNodeID: "n-a", kind: "calls" })
        yield* repo.putEdge({ id: "e2", fromNodeID: "n-c", toNodeID: "n-b", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const relatedDepth1 = yield* ri.relationships({ nodeID: "n-a", depth: 1 })
        const relatedDepth2 = yield* ri.relationships({ nodeID: "n-a", depth: 2 })

        expect(relatedDepth1.some((n) => n.id === "n-b")).toBe(true)
        expect(relatedDepth1.some((n) => n.id === "n-c")).toBe(false)

        expect(relatedDepth2.some((n) => n.id === "n-b")).toBe(true)
        expect(relatedDepth2.some((n) => n.id === "n-c")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("cycle is handled without looping forever", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f-a", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putFile({ id: "f-b", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })

        yield* repo.putNode({ id: "n-a", fileID: "f-a", kind: "function", name: "A", signature: "function A()", startLine: 1, endLine: 5, code: "function A() {}" })
        yield* repo.putNode({ id: "n-b", fileID: "f-b", kind: "function", name: "B", signature: "function B()", startLine: 1, endLine: 5, code: "function B() {}" })

        yield* repo.putEdge({ id: "e1", fromNodeID: "n-a", toNodeID: "n-b", kind: "calls" })
        yield* repo.putEdge({ id: "e2", fromNodeID: "n-b", toNodeID: "n-a", kind: "calls" })

        const ri = yield* RepositoryIntelligence.Service
        const related = yield* ri.relationships({ nodeID: "n-a", depth: 2 })

        expect(related.length).toBeGreaterThan(0)
        expect(related.some((n) => n.id === "n-b")).toBe(true)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
