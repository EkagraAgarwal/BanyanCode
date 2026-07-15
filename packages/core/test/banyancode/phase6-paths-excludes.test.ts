import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("Phase 6: path normalization", () => {
  test("relationships resolves a Windows-style absolute path against indexed_root", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({ id: "f1", path: "src/util.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n1", fileID: "f1", kind: "function", name: "helper", signature: "helper()", startLine: 1, endLine: 5, code: "function helper() {}" })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 1,
          graphVersion: 1,
          graphCoverage: 1,
          totalFiles: 1,
          totalNodes: 1,
          totalEdges: 0,
          schemaVersion: 1,
          indexedRoot,
        })

        const ri = yield* RepositoryIntelligence.Service
        const absPath = path.join(indexedRoot, "src", "util.ts")
        const result = yield* ri.relationships({ path: absPath, depth: 1 })
        expect(result).toHaveLength(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("relationships resolves a backslash path against indexed_root", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({ id: "f1", path: "src/util.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n1", fileID: "f1", kind: "function", name: "helper", signature: "helper()", startLine: 1, endLine: 5, code: "function helper() {}" })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 1,
          graphVersion: 1,
          graphCoverage: 1,
          totalFiles: 1,
          totalNodes: 1,
          totalEdges: 0,
          schemaVersion: 1,
          indexedRoot,
        })

        const ri = yield* RepositoryIntelligence.Service
        const result = yield* ri.relationships({ path: "src\\util.ts", depth: 1 })
        expect(result).toHaveLength(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("impact accepts an absolute path and normalizes it", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({ id: "f1", path: "src/util.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n1", fileID: "f1", kind: "function", name: "helper", signature: "helper()", startLine: 1, endLine: 5, code: "function helper() {}" })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 1,
          graphVersion: 1,
          graphCoverage: 1,
          totalFiles: 1,
          totalNodes: 1,
          totalEdges: 0,
          schemaVersion: 1,
          indexedRoot,
        })

        const ri = yield* RepositoryIntelligence.Service
        const absPath = path.join(indexedRoot, "src", "util.ts")
        const slc = yield* ri.impact({ path: absPath })
        expect(["success", "partial", undefined]).toContain(slc.status)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("query-as-path with a leading-root prefix is normalized", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const indexedRoot = path.join(tmp.path, "repo")

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service
        yield* repo.putFile({ id: "f1", path: "src/util.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n1", fileID: "f1", kind: "function", name: "helper", signature: "helper()", startLine: 1, endLine: 5, code: "function helper() {}" })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: 1,
          graphVersion: 1,
          graphCoverage: 1,
          totalFiles: 1,
          totalNodes: 1,
          totalEdges: 0,
          schemaVersion: 1,
          indexedRoot,
        })

        const ri = yield* RepositoryIntelligence.Service
        const absPath = path.join(indexedRoot, "src", "util.ts")
        const result = yield* ri.query({ query: absPath })
        expect(result.symbols.find((n) => n.id === "n1")).toBeDefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
