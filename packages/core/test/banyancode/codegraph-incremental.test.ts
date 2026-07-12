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

describe("CodegraphIndexer.indexFiles", () => {
  test("cache hit on unchanged file", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const filePath = path.join(tmp.path, "a.ts")
    await fs.writeFile(filePath, "function foo() { return 42 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // First call - should index the file
        const result1 = yield* indexer.indexFiles({ root: tmp.path, paths: [filePath] })
        expect(result1.indexed).toBe(1)
        expect(result1.skipped).toBe(0)

        // Verify file is in the repo
        const file1 = yield* repo.getFileByPath(filePath)
        expect(file1).toBeDefined()
        const contentHash1 = file1!.contentHash

        // Second call - should be a cache hit
        const result2 = yield* indexer.indexFiles({ root: tmp.path, paths: [filePath] })
        expect(result2.indexed).toBe(0)
        expect(result2.skipped).toBe(1)

        // Verify content_hash is unchanged (cache hit)
        const file2 = yield* repo.getFileByPath(filePath)
        expect(file2).toBeDefined()
        expect(file2!.contentHash).toBe(contentHash1)

        // Verify no parse errors were recorded
        const parseErrors = yield* repo.listParseErrors()
        expect(parseErrors.length).toBe(0)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("removeFiles deletes file from repo", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const filePath = path.join(tmp.path, "a.ts")
    await fs.writeFile(filePath, "function foo() { return 42 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // First, index the file
        const result1 = yield* indexer.indexFiles({ root: tmp.path, paths: [filePath] })
        expect(result1.indexed).toBe(1)

        // Verify file is in the repo
        const fileBefore = yield* repo.getFileByPath(filePath)
        expect(fileBefore).toBeDefined()

        // Remove the file
        yield* indexer.removeFiles({ root: tmp.path, paths: [filePath] })

        // Verify file is no longer in the repo
        const fileAfter = yield* repo.getFileByPath(filePath)
        expect(fileAfter).toBeUndefined()
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("indexFiles clears stale edges when file no longer references another", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const aPath = path.join(tmp.path, "consumer.ts")
    const bPath = path.join(tmp.path, "helper.ts")

    await fs.writeFile(aPath, "function myFunc() { return helper() }\n")
    await fs.writeFile(bPath, "export function helper() { return 42 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // Index each file separately to establish a baseline with edges
        yield* indexer.indexFiles({ root: tmp.path, paths: [bPath] })
        yield* indexer.indexFiles({ root: tmp.path, paths: [aPath] })

        const aFile = yield* repo.getFileByPath(aPath)
        expect(aFile).toBeDefined()
        const aNodes = yield* repo.listNodesByFile(aFile!.id)

        // Find the function node for myFunc
        const aFuncNode = aNodes.find((n) => n.kind === "function" && n.name === "myFunc")
        expect(aFuncNode).toBeDefined()

        // Count edges before modification
        const edgeCountBefore = yield* repo.countEdges()
        expect(edgeCountBefore).toBeGreaterThan(0)

        // Modify a.ts to remove the call to helper
        yield* Effect.promise(() => fs.writeFile(aPath, "function myFunc() { return 42 }\n"))

        // Re-index a.ts
        yield* indexer.indexFiles({ root: tmp.path, paths: [aPath] })

        // Verify edges are reduced
        const edgeCountAfter = yield* repo.countEdges()
        expect(edgeCountAfter).toBeLessThan(edgeCountBefore)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("removeFiles clears edges touching the removed file", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const aPath = path.join(tmp.path, "consumer.ts")
    const bPath = path.join(tmp.path, "helper.ts")

    await fs.writeFile(aPath, "function myFunc() { return helper() }\n")
    await fs.writeFile(bPath, "export function helper() { return 42 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // Index both files
        yield* indexer.indexFiles({ root: tmp.path, paths: [bPath] })
        yield* indexer.indexFiles({ root: tmp.path, paths: [aPath] })

        const bFile = yield* repo.getFileByPath(bPath)
        expect(bFile).toBeDefined()
        const bNodes = yield* repo.listNodesByFile(bFile!.id)
        const bFileNode = bNodes.find((n) => n.kind === "file")
        expect(bFileNode).toBeDefined()

        const edgeCountBefore = yield* repo.countEdges()
        expect(edgeCountBefore).toBeGreaterThan(0)

        // Remove b.ts
        yield* indexer.removeFiles({ root: tmp.path, paths: [bPath] })

        // Verify b.ts is gone
        const bFileAfter = yield* repo.getFileByPath(bPath)
        expect(bFileAfter).toBeUndefined()

        // Edges should be reduced after removing b.ts
        const edgeCountAfter = yield* repo.countEdges()
        expect(edgeCountAfter).toBeLessThan(edgeCountBefore)

        // Edges from b.ts file node should be gone
        if (bFileNode) {
          const edgesFromB = yield* repo.listEdgesByNode(bFileNode.id)
          expect(edgesFromB.length).toBe(0)
        }
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
