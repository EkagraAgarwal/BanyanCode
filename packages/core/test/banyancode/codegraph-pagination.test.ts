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
          })

        expect(result.graphVersion).toBe(1)
        const meta = yield* repo.getMeta()
        expect(meta?.totalNodes).toBe(25)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("listAllNodes and listAllEdges respect pagination (limit and offset)", async () => {
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

        // Seed some edges
        for (let i = 0; i < 9; i++) {
          yield* repo.putEdge({
            id: `edge-${i}`,
            fromNodeID: `node-${i}`,
            toNodeID: `node-${i + 1}`,
            kind: "calls",
          })
        }

        const nodesPage1 = yield* repo.listAllNodes({ limit: 4 })
        expect(nodesPage1.length).toBe(4)
        expect(nodesPage1[0].id).toBe("node-0")

        const nodesPage2 = yield* repo.listAllNodes({ limit: 4, offset: 4 })
        expect(nodesPage2.length).toBe(4)
        expect(nodesPage2[0].id).toBe("node-4")

        const edgesPage1 = yield* repo.listAllEdges({ limit: 3 })
        expect(edgesPage1.length).toBe(3)
        expect(edgesPage1[0].id).toBe("edge-0")

        const edgesPage2 = yield* repo.listAllEdges({ limit: 3, offset: 3 })
        expect(edgesPage2.length).toBe(3)
        expect(edgesPage2[0].id).toBe("edge-3")
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("queryNodes filters correctly using ORM", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* seed(10) // node-0 to node-9. functions are even indices (kind: "function"), classes are odd (kind: "class").

        // Filter by function name
        const matchFunc = yield* repo.queryNodes({ function: "func4" })
        expect(matchFunc.length).toBe(1)
        expect(matchFunc[0].id).toBe("node-4")

        // Filter by kind
        const matchKind = yield* repo.queryNodes({ kind: "class" })
        expect(matchKind.length).toBe(5) // odd indices: 1, 3, 5, 7, 9
        for (const n of matchKind) {
          expect(n.kind).toBe("class")
        }

        // Filter by both (either matches)
        const matchBoth = yield* repo.queryNodes({ function: "func4", kind: "class" })
        // "func4" is node-4 (kind: "function"). kind: "class" matches odd indices.
        // Combined should be node-4, node-1, node-3, node-5, node-7, node-9. Total = 6.
        expect(matchBoth.length).toBe(6)

        // Empty filter returns empty array
        const matchEmpty = yield* repo.queryNodes({})
        expect(matchEmpty.length).toBe(0)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
