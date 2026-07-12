import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

describe("CodegraphIndexer cross-session behavior", () => {
  test("indexFiles updates graphBuiltAt", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const fileA = path.join(tmp.path, "a.ts")
    const fileB = path.join(tmp.path, "b.ts")
    const fileC = path.join(tmp.path, "c.ts")

    await fs.writeFile(fileA, "function foo() { return 42 }\n")
    await fs.writeFile(fileB, "function bar() { return 99 }\n")
    await fs.writeFile(fileC, "function baz() { return 100 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // Index two files
        yield* indexer.indexFiles({ root: tmp.path, paths: [fileA, fileB] })

        // Read meta after first indexing
        const prevMeta = yield* repo.getMeta()
        expect(prevMeta).toBeDefined()
        expect(prevMeta!.graphBuiltAt).toBeGreaterThan(0)
        const prevBuiltAt = prevMeta!.graphBuiltAt

        // Add third file
        yield* indexer.indexFiles({ root: tmp.path, paths: [fileC] })

        // graphBuiltAt should be updated
        const newMeta = yield* repo.getMeta()
        expect(newMeta).toBeDefined()
        expect(newMeta!.graphBuiltAt).toBeGreaterThan(prevBuiltAt)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("removeFiles is a no-op when file is not in the graph", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const fileA = path.join(tmp.path, "a.ts")
    const nonexistent = path.join(tmp.path, "nonexistent.ts")

    await fs.writeFile(fileA, "function foo() { return 42 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // Index fileA
        yield* indexer.indexFiles({ root: tmp.path, paths: [fileA] })

        // Read graphVersion before
        const beforeMeta = yield* repo.getMeta()
        expect(beforeMeta).toBeDefined()
        const beforeVersion = beforeMeta!.graphVersion

        // Try to remove a file that was never indexed
        yield* indexer.removeFiles({ root: tmp.path, paths: [nonexistent] })

        // graphVersion should be unchanged
        const afterMeta = yield* repo.getMeta()
        expect(afterMeta).toBeDefined()
        expect(afterMeta!.graphVersion).toBe(beforeVersion)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("cross-session persistence - meta and files survive DB reopen", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    const fileA = path.join(tmp.path, "a.ts")
    const fileB = path.join(tmp.path, "b.ts")

    await fs.writeFile(fileA, "function foo() { return 42 }\n")
    await fs.writeFile(fileB, "function bar() { return 99 }\n")

    // Session 1: index two files
    const dbLayer1 = Database.layerFromPath(dbPath)
    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        yield* indexer.indexFiles({ root: tmp.path, paths: [fileA, fileB] })

        // Verify meta is set
        const meta = yield* repo.getMeta()
        expect(meta).toBeDefined()
        expect(meta!.graphVersion).toBeGreaterThan(0)
        expect(meta!.totalFiles).toBeGreaterThanOrEqual(2)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer1),
        Effect.scoped,
      ),
    )

    // Session 2: reopen DB at same path, verify data persists
    const dbLayer2 = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // Verify meta persisted
        const meta = yield* repo.getMeta()
        expect(meta).toBeDefined()
        expect(meta!.graphVersion).toBeGreaterThan(0)

        // Verify files persisted
        const files = yield* repo.listAllFiles()
        expect(files.length).toBeGreaterThanOrEqual(2)

        const paths = files.map((f) => f.path)
        expect(paths).toContain(fileA)
        expect(paths).toContain(fileB)
      }).pipe(
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer2),
        Effect.scoped,
      ),
    )
  })
})
