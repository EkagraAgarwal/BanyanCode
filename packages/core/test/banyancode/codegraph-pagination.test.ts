import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

const seed = (count: number) =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    for (let i = 0; i < count; i++) {
      const fileID = `file-${i}`
      yield* repo.putFile({
        id: fileID,
        path: `/test/${fileID}.ts`,
        contentHash: `hash-${i}`,
        language: "typescript",
        indexedAt: Date.now(),
      })
      yield* repo.putNode({
        id: `node-${i}`,
        fileID,
        kind: i % 2 === 0 ? "function" : "class",
        name: `func${i}`,
        signature: `func${i}()`,
        startLine: 1,
        endLine: 10,
        code: `function func${i}() {}`,
      })
    }
  })

describe("CodegraphRepo pagination and counts", () => {
  test("countNodes / countEdges / countFiles return cardinality", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(50)

        expect(yield* repo.countNodes()).toBe(50)
        expect(yield* repo.countFiles()).toBe(50)
        expect(yield* repo.countEdges()).toBe(0)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchNodes filters by name via SQL LIKE", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(20)

        const results = yield* repo.searchNodes({ name: "func1" })
        expect(results.length).toBeGreaterThan(0)
        for (const n of results) {
          expect(n.name).toContain("func1")
        }
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchNodes filters by kind via SQL =", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(10)

        const functions = yield* repo.searchNodes({ kind: "function" })
        const classes = yield* repo.searchNodes({ kind: "class" })
        expect(functions.length).toBe(5)
        expect(classes.length).toBe(5)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchNodes respects limit", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(100)

        const results = yield* repo.searchNodes({ limit: 5 })
        expect(results.length).toBe(5)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("bumpVersion uses counts not listAllNodes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(25)

        const result = yield* repo.bumpVersion({
          scannedFiles: 25,
          indexedFiles: 25,
          totalFiles: 25,
          totalNodes: 0,
          totalEdges: 0,
        })

        expect(result.graphVersion).toBe(1)
        const meta = yield* repo.getMeta()
        expect(meta?.totalNodes).toBe(25)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("nodesByIDs fetches multiple nodes in batch", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(10)

        const nodes = yield* repo.nodesByIDs(["node-1", "node-3", "node-5"])
        expect(nodes.length).toBe(3)
        expect(nodes.map((n) => n.id).sort()).toEqual(["node-1", "node-3", "node-5"])
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("putEdges batches multiple edge inserts in a transaction", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(5)

        const edges = [
          { id: "edge1", fromNodeID: "node-0", toNodeID: "node-1", kind: "calls" as const },
          { id: "edge2", fromNodeID: "node-2", toNodeID: "node-3", kind: "references" as const },
        ]

        yield* repo.putEdges(edges)

        const allEdges = yield* repo.listAllEdges()
        expect(allEdges.length).toBe(2)
        expect(allEdges.map((e) => e.id).sort()).toEqual(["edge1", "edge2"])
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("queryNodes filters in SQL correctly", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(10)

        // Filter by function name
        const node1 = yield* repo.queryNodes({ function: "func3" })
        expect(node1.length).toBe(1)
        expect(node1[0].id).toBe("node-3")

        // Filter by kind
        const classes = yield* repo.queryNodes({ kind: "class" })
        expect(classes.length).toBe(5)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("putFile upsert operates atomically", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "file-id", path: "src/file.ts", contentHash: "h1", language: "ts", indexedAt: 100 })
        yield* repo.putFile({ id: "file-id", path: "src/file.ts", contentHash: "h2", language: "ts", indexedAt: 200 })

        const file = yield* repo.getFileByPath("src/file.ts")
        expect(file).toBeDefined()
        expect(file?.contentHash).toBe("h2")
        expect(file?.indexedAt).toBe(200)
        expect(yield* repo.countFiles()).toBe(1)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
