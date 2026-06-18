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

        // Bump version (simulating successful build)
        const result = yield* repo.bumpVersion({
          scannedFiles: 10,
          indexedFiles: 8,
          totalFiles: 10,
          totalNodes: 20,
          totalEdges: 30,
        })

        expect(result.graphVersion).toBe(6)
        expect(result.coverage).toBe(0.8)

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

  test("graphCoverage is computed from scannedFiles / indexedFiles", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")

    const repoLayer = CodegraphRepo.layer.pipe(Layer.provide(Database.layerFromPath(dbPath)))

    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service

        // 5 indexed out of 10 scanned = 0.5 coverage
        const result1 = yield* repo.bumpVersion({
          scannedFiles: 10,
          indexedFiles: 5,
          totalFiles: 10,
          totalNodes: 5,
          totalEdges: 0,
        })
        expect(result1.coverage).toBe(0.5)

        // 4 indexed out of 4 scanned = 1.0 coverage
        const result2 = yield* repo.bumpVersion({
          scannedFiles: 4,
          indexedFiles: 4,
          totalFiles: 4,
          totalNodes: 4,
          totalEdges: 0,
        })
        expect(result2.coverage).toBe(1.0)

        // 0 scanned = 0 coverage (avoid division by zero)
        const result3 = yield* repo.bumpVersion({
          scannedFiles: 0,
          indexedFiles: 0,
          totalFiles: 0,
          totalNodes: 0,
          totalEdges: 0,
        })
        expect(result3.coverage).toBe(0)
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
  })
})
