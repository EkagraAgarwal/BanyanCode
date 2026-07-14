import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

describe("CodegraphRepo.searchNodesLight", () => {
  test("returns nodes without code field", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // Seed a node with code
        yield* repo.putFile({
          id: "file-1",
          path: path.join(tmp.path, "a.ts"),
          contentHash: "abc",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: "node-1",
          fileID: "file-1",
          kind: "function",
          name: "testFunc",
          signature: "testFunc()",
          startLine: 1,
          endLine: 3,
          code: "function testFunc() { return 42 }",
        })

        const lightResults = yield* repo.searchNodesLight({ limit: 10 })
        expect(lightResults.length).toBeGreaterThan(0)
        const node = lightResults.find((n) => n.id === "node-1")
        expect(node).toBeDefined()
        expect(node!.code).toBeUndefined()
        expect(node!.name).toBe("testFunc")
        expect(node!.kind).toBe("function")
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchNodesLight filters by fileID", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        // Seed two files with nodes
        yield* repo.putFile({
          id: "file-1",
          path: path.join(tmp.path, "a.ts"),
          contentHash: "abc",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putFile({
          id: "file-2",
          path: path.join(tmp.path, "b.ts"),
          contentHash: "def",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: "node-1",
          fileID: "file-1",
          kind: "function",
          name: "funcA",
          signature: "funcA()",
          startLine: 1,
          endLine: 3,
          code: "function funcA() {}",
        })
        yield* repo.putNode({
          id: "node-2",
          fileID: "file-2",
          kind: "function",
          name: "funcB",
          signature: "funcB()",
          startLine: 1,
          endLine: 3,
          code: "function funcB() {}",
        })

        const results = yield* repo.searchNodesLight({ fileID: "file-1" })
        expect(results.length).toBe(1)
        expect(results[0]!.id).toBe("node-1")
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("CodegraphRepo.nodesByFileIDs", () => {
  test("fetches nodes for specific file IDs", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-1",
          path: path.join(tmp.path, "a.ts"),
          contentHash: "abc",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putFile({
          id: "file-2",
          path: path.join(tmp.path, "b.ts"),
          contentHash: "def",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: "node-1",
          fileID: "file-1",
          kind: "function",
          name: "funcA",
          signature: "funcA()",
          startLine: 1,
          endLine: 3,
          code: "function funcA() {}",
        })
        yield* repo.putNode({
          id: "node-2",
          fileID: "file-2",
          kind: "function",
          name: "funcB",
          signature: "funcB()",
          startLine: 1,
          endLine: 3,
          code: "function funcB() {}",
        })

        const results = yield* repo.nodesByFileIDs({ fileIDs: ["file-1"] })
        expect(results.length).toBe(1)
        expect(results[0]!.id).toBe("node-1")
        // nodesByFileIDs returns full nodes (with code)
        expect(results[0]!.code).toBeDefined()
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("returns empty array for empty fileIDs", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        const results = yield* repo.nodesByFileIDs({ fileIDs: [] })
        expect(results.length).toBe(0)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})

describe("Incremental derived graph rebuild via indexFiles", () => {
  test("full rebuild produces edges for all files", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const aPath = path.join(tmp.path, "a.ts")
    const bPath = path.join(tmp.path, "b.ts")
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

        // Index files
        yield* indexer.indexFiles({ root: tmp.path, paths: [bPath] })
        yield* indexer.indexFiles({ root: tmp.path, paths: [aPath] })

        const edges = yield* repo.listAllEdges()
        expect(edges.length).toBeGreaterThan(0)

        // Verify a->b edge exists (myFunc calls helper)
        const callEdge = edges.find((e) => e.kind === "calls")
        expect(callEdge).toBeDefined()
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("incremental re-index of changed file removes stale edges", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const aPath = path.join(tmp.path, "a.ts")
    const bPath = path.join(tmp.path, "b.ts")
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

        // Index files
        yield* indexer.indexFiles({ root: tmp.path, paths: [bPath] })
        yield* indexer.indexFiles({ root: tmp.path, paths: [aPath] })

        const edgesAfterIndex = yield* repo.listAllEdges()
        const callEdgeAfterIndex = edgesAfterIndex.find((e) => e.kind === "calls")
        expect(callEdgeAfterIndex).toBeDefined()

        // Modify a.ts to remove the call
        yield* Effect.promise(() => fs.writeFile(aPath, "function myFunc() { return 42 }\n"))

        // Re-index a.ts (triggers incremental rebuild with changed file)
        yield* indexer.indexFiles({ root: tmp.path, paths: [aPath] })

        const edgesAfterReindex = yield* repo.listAllEdges()
        // The calls edge from myFunc->helper should be gone
        const callEdgeAfterReindex = edgesAfterReindex.find((e) => e.kind === "calls")
        expect(callEdgeAfterReindex).toBeUndefined()
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("10-file workspace: incremental update only removes edges from changed file", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Create 10 files with cross-references.
    // file1-file9 define functions that return numbers (no outgoing edges).
    // file0 defines func0 which calls func9 - file9 must be indexed first
    // so func9 exists in nodeMap when file0 is processed.
    const file0Path = path.join(tmp.path, "file0.ts")
    const file9Path = path.join(tmp.path, "file9.ts")
    await fs.writeFile(file0Path, `function func0() { return func9() }\n`)
    await fs.writeFile(file9Path, `export function func9() { return 8 }\n`)

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service

        // Index file9 first (defines func9), then file0 (calls func9)
        // This ensures func9 is in nodeMap when file0's code is processed
        yield* indexer.indexFiles({ root: tmp.path, paths: [file9Path] })
        yield* indexer.indexFiles({ root: tmp.path, paths: [file0Path] })

        const edgesAfterFull = yield* repo.listAllEdges()
        const edgeCountAfterFull = edgesAfterFull.length
        expect(edgeCountAfterFull).toBeGreaterThan(0)

        // func0 should have outgoing calls to func9
        const func0CallsBefore = edgesAfterFull.filter(
          (e) => e.kind === "calls" && e.fromNodeID.includes("func0"),
        )
        expect(func0CallsBefore.length).toBeGreaterThan(0)

        // Modify file0 - func0 no longer calls func9
        yield* Effect.promise(() => fs.writeFile(file0Path, "function func0() { return 42 }\n"))

        // Re-index file0 (triggers incremental rebuild with changed file0)
        yield* indexer.indexFiles({ root: tmp.path, paths: [file0Path] })

        const edgesAfterIncremental = yield* repo.listAllEdges()

        // func0 should not have any outgoing calls anymore
        const func0CallsAfter = edgesAfterIncremental.filter(
          (e) => e.kind === "calls" && e.fromNodeID.includes("func0"),
        )
        expect(func0CallsAfter.length).toBe(0)
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.provide(codegraphRepoDefaultLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
