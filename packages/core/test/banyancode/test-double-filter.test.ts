import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "../../src/banyancode/codegraph-repo"
import { RepositoryIntelligence } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const seedGraph = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    yield* repo.putFile({ id: "file-src", path: "src/banyancode/memory-repo.ts", contentHash: "h-src", language: "typescript", indexedAt: 1 })
    yield* repo.putFile({ id: "file-test", path: "src/banyancode/memory-repo.test.ts", contentHash: "h-test", language: "typescript", indexedAt: 2 })
    yield* repo.putFile({ id: "file-handler", path: "src/handlers/memory-handler.ts", contentHash: "h-h", language: "typescript", indexedAt: 4 })

    // Source class
    yield* repo.putNode({
      id: "sym-memoryrepo",
      fileID: "file-src",
      kind: "class",
      name: "MemoryRepo",
      startLine: 1,
      endLine: 10,
    })
    // Real test that references the source
    yield* repo.putNode({
      id: "sym-memtest",
      fileID: "file-test",
      kind: "test",
      name: "memoryRepoTest",
      startLine: 1,
      endLine: 20,
    })
    // Test-double: a helper function defined inside the test file that the
    // BFS would otherwise surface as a "caller". The filter must drop it
    // because its fileID lives in a `.test.ts` path.
    yield* repo.putNode({
      id: "sym-mock",
      fileID: "file-test",
      kind: "function",
      name: "makeMockMemoryRepo",
      startLine: 25,
      endLine: 40,
    })
    // Real source caller
    yield* repo.putNode({
      id: "sym-handler",
      fileID: "file-handler",
      kind: "function",
      name: "memoryHandler",
      startLine: 1,
      endLine: 15,
    })

    yield* repo.putEdge({ id: "e-mock-src", fromNodeID: "sym-mock", toNodeID: "sym-memoryrepo", kind: "calls" })
    yield* repo.putEdge({ id: "e-handler-src", fromNodeID: "sym-handler", toNodeID: "sym-memoryrepo", kind: "calls" })
    yield* repo.putEdge({ id: "e-test-src", fromNodeID: "sym-memtest", toNodeID: "sym-memoryrepo", kind: "tested_by" })
  })

const testLayer = Layer.mergeAll(
  RepositoryIntelligence.defaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("repository_explain/trace — test-double filter", () => {
  test("explain directCallers excludes nodes from .test. and .test-double. files", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedGraph()

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.explain({ symbol: "MemoryRepo" })

        const names = slc.directCallers.map((n) => n.name)
        expect(names).toContain("memoryHandler")
        // The test-double helper lives in a `.test.ts` file — it must NOT
        // show up in source-intent directCallers. Without the filter it would.
        expect(names).not.toContain("makeMockMemoryRepo")
        expect(names).not.toContain("memoryRepoTest")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("trace transitiveDependents also excludes test-file paths", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedGraph()

        const ri = yield* RepositoryIntelligence.Service
        const slc = yield* ri.trace({ symbol: "MemoryRepo", depth: 3, limit: 50 })

        const names = slc.transitiveDependents.map((n) => n.name)
        expect(names).not.toContain("makeMockMemoryRepo")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})