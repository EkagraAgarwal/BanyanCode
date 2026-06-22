import { describe, expect, test } from "bun:test"
import { Effect, Layer, Cause } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

describe("CodegraphRepo vector search", () => {
  test("resetEmbeddingsTable preserves embeddings for the OLD model", async () => {
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

        const embedding = new Uint8Array(1536 * 4)
        for (let i = 0; i < embedding.length; i++) {
          embedding[i] = Math.random() * 255
        }
        yield* repo.putEmbedding("node-1", embedding, "old-model", 1536)

        const before = yield* repo.getEmbedding("node-1")
        expect(before?.model).toBe("old-model")

        yield* repo.resetEmbeddingsTable(1536, "new-model")

        const after = yield* repo.getEmbedding("node-1")
        expect(after?.model).toBe("old-model")
        expect(after?.dim).toBe(1536)
      }).pipe(Effect.provide(repoLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("resetEmbeddingsTable with { force: true } clears ALL embeddings", async () => {
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

        const embedding = new Uint8Array(1536 * 4)
        yield* repo.putEmbedding("node-1", embedding, "old-model", 1536)

        yield* repo.resetEmbeddingsTable(1536, "new-model", { force: true })

        const after = yield* repo.getEmbedding("node-1")
        expect(after).toBeUndefined()
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

        const embedding = new Uint8Array(1536 * 4)
        yield* repo.putEmbedding("node-1", embedding, "test-model", 1536)

        const wrongDimQuery = new Float32Array(768)
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
