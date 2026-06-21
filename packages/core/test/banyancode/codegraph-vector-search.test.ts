import { describe, expect, test } from "bun:test"
import { Effect, Layer, Cause } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

describe("CodegraphRepo vector search", () => {
  test("resetEmbeddingsTable recreates with new dim", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* CodegraphRepo.Service

        // Reset to dim=384 first (fresh migration creates 1536)
        yield* repo.resetEmbeddingsTable(384, "test-model-384")

        // Create a file and node first
        yield* repo.putFile({
          id: "file-1",
          path: "/test/file.ts",
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
          endLine: 10,
          code: "function testFunc() {}",
        })

        // Insert 384-dim embedding
        const embedding384 = new Uint8Array(384 * 4)
        for (let i = 0; i < embedding384.length; i++) {
          embedding384[i] = Math.random() * 255
        }
        yield* repo.putEmbedding("node-1", embedding384, "test-model-384", 384)

        // Verify it exists
        const stored = yield* repo.getEmbedding("node-1")
        expect(stored?.dim).toBe(384)

        // Reset to dim=1536
        yield* repo.resetEmbeddingsTable(1536, "test-model-1536")

        // Old embedding should be gone
        const afterReset = yield* repo.getEmbedding("node-1")
        expect(afterReset).toBeUndefined()

        // Insert 1536-dim embedding
        const embedding1536 = new Uint8Array(1536 * 4)
        for (let i = 0; i < embedding1536.length; i++) {
          embedding1536[i] = Math.random() * 255
        }
        yield* repo.putEmbedding("node-1", embedding1536, "test-model-1536", 1536)

        // Verify new embedding
        const newStored = yield* repo.getEmbedding("node-1")
        expect(newStored?.dim).toBe(1536)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchByVector rejects wrong dim query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* CodegraphRepo.Service

        // Reset to dim=384 (fresh migration creates 1536)
        yield* repo.resetEmbeddingsTable(384, "test-model")

        // Create file and node
        yield* repo.putFile({
          id: "file-1",
          path: "/test/file.ts",
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
          endLine: 10,
          code: "function testFunc() {}",
        })

        // Insert 384-dim embedding
        const embedding384 = new Uint8Array(384 * 4)
        yield* repo.putEmbedding("node-1", embedding384, "test-model", 384)

        // Try to search with 1536-dim query - should fail with CodegraphSearchError
        const wrongDimQuery = new Float32Array(1536)
        const exit = yield* repo.searchByVector(wrongDimQuery, { limit: 5 }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const errorMsg = Cause.prettyErrors(exit.cause).join("\n")
          expect(errorMsg).toContain("does not match column dim")
        }
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("resetEmbeddingsTable rejects invalid dim", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const repoLayer = CodegraphRepo.layer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* CodegraphRepo.Service

        // Try invalid dims - these should all fail
        const invalidDims = [0, -1, 100000, 70000, 0.5, NaN]

        for (const invalidDim of invalidDims) {
          let caught = false
          try {
            Effect.runSync(repo.resetEmbeddingsTable(invalidDim as number, "test-model"))
          } catch (e) {
            caught = true
            expect((e as Error).message).toContain("Invalid embedding dim")
          }
          expect(caught).toBe(true)
        }
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
