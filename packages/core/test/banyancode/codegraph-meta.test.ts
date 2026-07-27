import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"

// Set BANYANCODE_ENABLE for all tests
process.env.BANYANCODE_ENABLE = "1"

const SCHEMA_VERSION = 1

describe("codegraph-meta", () => {
  test("bumpVersion only increments on success", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // Seed version 5 directly
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 1000,
          graphVersion: 5,
          graphCoverage: 0.5,
          totalFiles: 10,
          totalNodes: 20,
          totalEdges: 30,
          schemaVersion: SCHEMA_VERSION,
        })

        // Bump version (simulating successful build). Phase 0: the
        // numerator is the row count of codegraph_files, not whatever
        // the caller passes as `indexedFiles` — so we seed the DB with
        // 8 files first and pass eligibleFiles=10 to get 8/10 = 0.8.
        yield* repo.putFile({
          id: "f-1",
          path: "/a.ts",
          contentHash: "h",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.putFile({
          id: "f-2",
          path: "/b.ts",
          contentHash: "h",
          language: "typescript",
          indexedAt: Date.now(),
        })
        for (let i = 3; i <= 8; i++) {
          yield* repo.putFile({
            id: `f-${i}`,
            path: `/x${i}.ts`,
            contentHash: "h",
            language: "typescript",
            indexedAt: Date.now(),
          })
        }

        const result = yield* repo.bumpVersion({
          eligibleFiles: 10,
          indexedFiles: 8,
        })

        expect(result.graphVersion).toBe(6)
        expect(result.coverage).toBe(0.8)
        expect(result.totalNodes).toBe(0)
        expect(result.totalEdges).toBe(0)

        // Simulate a failed build that does NOT call bumpVersion
        // Reset to version 5 to simulate "failed build didn't bump"
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 2000,
          graphVersion: 5,
          graphCoverage: 0.5,
          totalFiles: 10,
          totalNodes: 20,
          totalEdges: 30,
          schemaVersion: SCHEMA_VERSION,
        })

        // Verify version is still 5 (no bump happened)
        const meta = yield* repo.getMeta()
        expect(meta?.graphVersion).toBe(5)
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })

  test("graphCoverage is computed from codegraph_files rows / eligibleFiles", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // Seed 5 file rows; eligibleFiles=10 -> 5/10 = 0.5 coverage.
        for (let i = 0; i < 5; i++) {
          yield* repo.putFile({
            id: `f-${i}`,
            path: `/f${i}.ts`,
            contentHash: "h",
            language: "typescript",
            indexedAt: Date.now(),
          })
        }
        const result1 = yield* repo.bumpVersion({
          eligibleFiles: 10,
          indexedFiles: 5,
        })
        expect(result1.coverage).toBe(0.5)

        // 0 / 0 = 0 (avoid division by zero) — wipe the rows first so
        // the existing 5 don't keep the count above the denominator.
        yield* repo.clearAll({ dropFile: true })
        const result3 = yield* repo.bumpVersion({
          eligibleFiles: 0,
          indexedFiles: 0,
        })
        expect(result3.coverage).toBe(0)
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })

  test("graphCoverage clamps at 1.0 — when rows >= eligible, coverage is 1.0", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // 4 indexed rows, eligible = 4 -> 1.0
        for (let i = 0; i < 4; i++) {
          yield* repo.putFile({
            id: `f-${i}`,
            path: `/g${i}.ts`,
            contentHash: "h",
            language: "typescript",
            indexedAt: Date.now(),
          })
        }
        const result2 = yield* repo.bumpVersion({
          eligibleFiles: 4,
          indexedFiles: 4,
        })
        expect(result2.coverage).toBe(1.0)
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })
})
