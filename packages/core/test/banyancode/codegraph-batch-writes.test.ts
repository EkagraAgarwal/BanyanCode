import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { tmpdir } from "../fixture/tmpdir"
import { Service as CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

describe("codegraph batch writes", () => {
  test("putNodes handles >32766 SQL variables via internal chunking", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo

      yield* repo.putFile({
        id: "f-0",
        path: "src/big.ts",
        contentHash: "h-0",
        language: "typescript",
        indexedAt: 1,
      })

      const nodes = Array.from({ length: 4200 }, (_, i) => ({
        id: `n-${i}`,
        fileID: "f-0",
        kind: "function" as const,
        name: `aaa-fn-${i}`,
        startLine: (i % 50) + 1,
        endLine: (i % 50) + 5,
      }))

      // Pre-fix this threw EffectDrizzleQueryError: 4200 rows x 10 cols =
      // 42,000 bound variables exceed SQLITE_MAX_VARIABLE_NUMBER (32,766).
      yield* repo.putNodes(nodes)

      const count = yield* repo.countNodes()
      expect(count).toBe(4200)

      const hit = yield* repo.searchNodes({ name: "aaa-fn-2100" })
      expect(hit.length).toBe(1)
      expect(hit[0].name).toBe("aaa-fn-2100")
    }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped, Effect.runPromise)
  })

  test("putEdges handles >32766 SQL variables (chunked contract stays intact)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      const repo = yield* CodegraphRepo

      yield* repo.putFile({
        id: "f-0",
        path: "src/chain.ts",
        contentHash: "h-0",
        language: "typescript",
        indexedAt: 1,
      })
      const nodes = Array.from({ length: 4001 }, (_, i) => ({
        id: `n-${i}`,
        fileID: "f-0",
        kind: "function" as const,
        name: `aaa-chain-${i}`,
        startLine: 1,
        endLine: 2,
      }))
      yield* repo.putNodes(nodes)

      const edges = Array.from({ length: 4000 }, (_, i) => ({
        id: `e-${i}`,
        fromNodeID: `n-${i + 1}`,
        toNodeID: `n-${i}`,
        kind: "calls" as const,
      }))
      yield* repo.putEdges(edges)

      expect(yield* repo.countEdges()).toBe(4000)
      const callers = yield* repo.edgesTo("n-0")
      expect(callers.length).toBe(1)
      expect(callers[0].fromNodeID).toBe("n-1")
    }).pipe(Effect.provide(codegraphRepoDefaultLayer), Effect.provide(dbLayer), Effect.scoped, Effect.runPromise)
  })
})
