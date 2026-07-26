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

  test("applyChanges rebuilds existing dependents when a changed endpoint is replaced", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const helperPath = path.join(tmp.path, "helper.ts")
    const consumerPath = path.join(tmp.path, "consumer.ts")
    await fs.writeFile(helperPath, "export function helper() { return 42 }\n")
    // Keep the future symbol in the persisted consumer code. It is not a
    // target until helper.ts is changed, which makes the dependent-source
    // rebuild observable without re-indexing consumer.ts.
    await fs.writeFile(
      consumerPath,
      "export function useHelper(flag: boolean) { return flag ? helper() : helper_v2() }\n",
    )

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        yield* indexer.indexFiles({ root: tmp.path, paths: [helperPath, consumerPath] })

        const helperFile = yield* repo.getFileByPath(helperPath)
        const consumerFile = yield* repo.getFileByPath(consumerPath)
        expect(helperFile).toBeDefined()
        expect(consumerFile).toBeDefined()
        if (!helperFile || !consumerFile) return

        const dependentsBefore = yield* repo.dependentsOfFiles({ fileIDs: [helperFile.id] })
        expect(dependentsBefore).toEqual([consumerFile.id])

        const consumerNodes = yield* repo.listNodesByFile(consumerFile.id)
        const useHelper = consumerNodes.find((node) => node.kind === "function" && node.name === "useHelper")
        expect(useHelper).toBeDefined()
        const helperNodes = yield* repo.listNodesByFile(helperFile.id)
        const oldHelper = helperNodes.find((node) => node.kind === "function" && node.name === "helper")
        expect(oldHelper).toBeDefined()
        if (!useHelper || !oldHelper) return

        const initialEdges = yield* repo.listAllEdges()
        expect(
          initialEdges.some(
            (edge) => edge.kind === "calls" && edge.fromNodeID === useHelper.id && edge.toNodeID === oldHelper.id,
          ),
        ).toBe(true)

        yield* Effect.promise(() => fs.writeFile(helperPath, "export function helper_v2() { return 43 }\n"))
        const result = yield* indexer.applyChanges({
          root: tmp.path,
          addedOrChanged: [helperPath],
          removed: [],
        })
        expect(result.indexed).toBe(1)

        const updatedHelperFile = yield* repo.getFileByPath(helperPath)
        expect(updatedHelperFile).toBeDefined()
        if (!updatedHelperFile) return
        const updatedHelperNodes = yield* repo.listNodesByFile(updatedHelperFile.id)
        const newHelper = updatedHelperNodes.find((node) => node.kind === "function" && node.name === "helper_v2")
        expect(newHelper).toBeDefined()
        if (!newHelper) return

        const edgesAfter = yield* repo.listAllEdges()
        expect(
          edgesAfter.some(
            (edge) => edge.kind === "calls" && edge.fromNodeID === useHelper.id && edge.toNodeID === newHelper.id,
          ),
        ).toBe(true)
        expect(
          edgesAfter.some(
            (edge) => edge.kind === "calls" && edge.fromNodeID === useHelper.id && edge.toNodeID === oldHelper.id,
          ),
        ).toBe(false)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("applyChanges batches added and removed paths into one graph update", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const consumerPath = path.join(tmp.path, "consumer.ts")
    const oldHelperPath = path.join(tmp.path, "old-helper.ts")
    const newHelperPath = path.join(tmp.path, "new-helper.ts")

    await fs.writeFile(consumerPath, "export function useHelper() { return oldHelper() }\n")
    await fs.writeFile(oldHelperPath, "export function oldHelper() { return 1 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        yield* indexer.indexFiles({ root: tmp.path, paths: [consumerPath, oldHelperPath] })

        const oldFile = yield* repo.getFileByPath(oldHelperPath)
        expect(oldFile).toBeDefined()
        const oldNodes = oldFile ? yield* repo.listNodesByFile(oldFile.id) : []
        const oldNodeIDs = new Set(oldNodes.map((node) => node.id))
        const edgeCountBefore = yield* repo.countEdges()
        expect(edgeCountBefore).toBeGreaterThan(0)
        const versionBefore = (yield* repo.getMeta())?.graphVersion ?? -1
        expect(versionBefore).toBeGreaterThanOrEqual(0)

        yield* Effect.promise(() => fs.writeFile(consumerPath, "export function useHelper() { return newHelper() }\n"))
        yield* Effect.promise(() => fs.writeFile(newHelperPath, "export function newHelper() { return 2 }\n"))
        yield* Effect.promise(() => fs.unlink(oldHelperPath))

        const result = yield* indexer.applyChanges({
          root: tmp.path,
          addedOrChanged: [consumerPath, newHelperPath],
          removed: [oldHelperPath],
        })

        expect(result.indexed).toBe(2)
        expect(result.removed).toBe(1)
        expect(result.skipped).toBe(0)
        expect((yield* repo.getMeta())?.graphVersion).toBe(versionBefore + 1)
        expect(yield* repo.getFileByPath(oldHelperPath)).toBeUndefined()

        const newFile = yield* repo.getFileByPath(newHelperPath)
        const consumerFile = yield* repo.getFileByPath(consumerPath)
        expect(newFile).toBeDefined()
        expect(consumerFile).toBeDefined()
        const newNodes = newFile ? yield* repo.listNodesByFile(newFile.id) : []
        const consumerNodes = consumerFile ? yield* repo.listNodesByFile(consumerFile.id) : []
        const newHelper = newNodes.find((node) => node.kind === "function" && node.name === "newHelper")
        const useHelper = consumerNodes.find((node) => node.kind === "function" && node.name === "useHelper")
        expect(newHelper).toBeDefined()
        expect(useHelper).toBeDefined()

        const edgesAfter = yield* repo.listAllEdges()
        expect(edgesAfter.length).toBe(edgeCountBefore)
        expect(edgesAfter.some((edge) => oldNodeIDs.has(edge.fromNodeID) || oldNodeIDs.has(edge.toNodeID))).toBe(false)
        expect(
          edgesAfter.some(
            (edge) => edge.kind === "calls" && edge.fromNodeID === useHelper?.id && edge.toNodeID === newHelper?.id,
          ),
        ).toBe(true)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("applyChanges skips ignored and oversized paths in a mixed batch", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const ignoredPath = path.join(tmp.path, "ignored.ts")
    const oversizedPath = path.join(tmp.path, "oversized.ts")
    const keepPath = path.join(tmp.path, "keep.ts")
    await fs.writeFile(ignoredPath, "export const ignored = 1\n")
    await fs.writeFile(oversizedPath, `export const oversized = "${"x".repeat(256)}"\n`)
    await fs.writeFile(keepPath, "export const keep = 1\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        const initial = yield* indexer.indexFiles({
          root: tmp.path,
          paths: [ignoredPath, oversizedPath],
          maxFileSizeBytes: 1024,
        })
        expect(initial.indexed).toBe(2)
        const versionBefore = (yield* repo.getMeta())?.graphVersion ?? -1
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "ignored.ts\n"))

        const result = yield* indexer.applyChanges({
          root: tmp.path,
          addedOrChanged: [keepPath, oversizedPath],
          removed: [ignoredPath],
          maxFileSizeBytes: 64,
        })

        expect(result.indexed).toBe(1)
        expect(result.removed).toBe(0)
        expect(result.skipped).toBe(2)
        expect((yield* repo.getMeta())?.graphVersion).toBe(versionBefore + 1)
        expect(yield* repo.getFileByPath(ignoredPath)).toBeUndefined()
        expect(yield* repo.getFileByPath(oversizedPath)).toBeUndefined()
        expect(yield* repo.getFileByPath(keepPath)).toBeDefined()
        expect(yield* repo.countFiles()).toBe(1)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
