import { describe, expect, test } from "bun:test"
import path from "path"
import fsSync from "fs"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

describe("codegraph-remove", () => {
  test("clearAll wipes all 4 tables atomically and targets Database.path() for dropFile", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "codegraph.sqlite")

    // Snapshot the previous OPENCODE_DB so a failure in this test does not
    // leak the tmpdir path into subsequent tests (Database.path() reads it).
    const previousOpencodeDb = process.env.OPENCODE_DB
    process.env.OPENCODE_DB = dbPath

    const { CodegraphRepo, layer: repoLayerInner } = await import("../../src/banyancode/codegraph-repo")
    const { Database } = await import("@opencode-ai/core/database/database")
    const { Effect, Layer } = await import("effect")

    const repoLayer = repoLayerInner.pipe(Layer.provide(Database.layerFromPath(dbPath)))

    const seedResult = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({
          id: "file-1",
          path: "/test/file.ts",
          contentHash: "abc123",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putNode({
          id: "node-1",
          fileID: "file-1",
          kind: "function",
          name: "testFn",
          startLine: 1,
          endLine: 5,
        })
        yield* repo.putNode({
          id: "node-2",
          fileID: "file-1",
          kind: "function",
          name: "callee",
          startLine: 10,
          endLine: 12,
        })
        yield* repo.putEdge({
          id: "edge-1",
          fromNodeID: "node-1",
          toNodeID: "node-2",
          kind: "calls",
        })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: Date.now(),
          graphVersion: 1,
          graphCoverage: 1.0,
          totalFiles: 1,
          totalNodes: 2,
          totalEdges: 1,
          schemaVersion: 1,
        })

        return yield* Effect.all({
          nodes: repo.countNodes(),
          edges: repo.countEdges(),
          files: repo.countFiles(),
          meta: repo.getMeta(),
        })
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )

    expect(seedResult.nodes).toBe(2)
    expect(seedResult.edges).toBe(1)
    expect(seedResult.files).toBe(1)
    expect(seedResult.meta?.graphVersion).toBe(1)
    expect(fsSync.existsSync(dbPath)).toBe(true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        yield* repo.clearAll({ dropFile: false })
        const after = yield* Effect.all({
          nodes: repo.countNodes(),
          edges: repo.countEdges(),
          files: repo.countFiles(),
          meta: repo.getMeta(),
        })
        expect(after.nodes).toBe(0)
        expect(after.edges).toBe(0)
        expect(after.files).toBe(0)
        expect(after.meta).toBeUndefined()
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )

    expect(fsSync.existsSync(dbPath)).toBe(true)

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({
          id: "file-2",
          path: "/test/seeded.ts",
          contentHash: "rebuild",
          language: "typescript",
          indexedAt: Date.now(),
        })
        expect(yield* repo.countFiles()).toBe(1)

        yield* repo.clearAll({ dropFile: true })
        expect(yield* repo.countFiles()).toBe(0)
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )

    Bun.gc(true)
    await new Promise((r) => setTimeout(r, 100))

    if (fsSync.existsSync(dbPath)) {
      fsSync.unlinkSync(dbPath)
    }
    expect(fsSync.existsSync(dbPath)).toBe(false)

    if (previousOpencodeDb === undefined) {
      delete process.env.OPENCODE_DB
    } else {
      process.env.OPENCODE_DB = previousOpencodeDb
    }
  })
})