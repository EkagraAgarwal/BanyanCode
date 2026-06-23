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
})
