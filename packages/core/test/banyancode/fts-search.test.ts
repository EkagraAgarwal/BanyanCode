import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const previousOpencodeDb = process.env.OPENCODE_DB
afterEach(() => {
  if (previousOpencodeDb === undefined) {
    delete process.env.OPENCODE_DB
  } else {
    process.env.OPENCODE_DB = previousOpencodeDb
  }
})

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

describe("fts-search", () => {
  test("single-token exact match does NOT use FTS (no fts-fallback diagnostic)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f1", path: "src/helper.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n1", fileID: "f1", kind: "function", name: "helper", startLine: 1, endLine: 5, code: "function helper() {}" })

        const ri = yield* RepositoryIntelligence.Service
        const ctx = yield* ri.query({ query: "helper" })

        const ftsDiag = ctx.diagnostics?.find((d) => d.kind === "fts-fallback")
        expect(ftsDiag).toBeUndefined()
        expect(ctx.searchDerivation).toBeUndefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("multi-token query uses FTS and returns fts-fallback diagnostic", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f2", path: "src/run.ts", contentHash: "h2", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n2", fileID: "f2", kind: "function", name: "runTask", startLine: 1, endLine: 5, code: "function runTask() { helper() }" })
        yield* repo.rebuildFtsIndex()

        const ri = yield* RepositoryIntelligence.Service
        const ctx = yield* ri.query({ query: "helper run" })

        const ftsDiag = ctx.diagnostics?.find((d) => d.kind === "fts-fallback")
        expect(ftsDiag).toBeDefined()
        expect(ctx.searchDerivation).toBe("fts-bm25")
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("bm25 ordering: results are sorted by bm25 ascending", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f3", path: "src/worker.ts", contentHash: "h3", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n3a", fileID: "f3", kind: "function", name: "taskAlpha", startLine: 1, endLine: 5, code: "function taskAlpha() { run() }" })
        yield* repo.putNode({ id: "n3b", fileID: "f3", kind: "function", name: "taskBeta", startLine: 6, endLine: 10, code: "function taskBeta() { run() }" })
        yield* repo.putNode({ id: "n3c", fileID: "f3", kind: "function", name: "taskGamma", startLine: 11, endLine: 15, code: "function taskGamma() { run() }" })

        const hits = yield* repo.ftsSearchNodes({ query: "run", limit: 10 })

        expect(hits.length).toBeGreaterThanOrEqual(3)
        for (let i = 1; i < hits.length; i++) {
          expect(hits[i].bm25).toBeGreaterThanOrEqual(hits[i - 1].bm25)
        }
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("empty query returns no FTS hits", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f4", path: "src/empty.ts", contentHash: "h4", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n4", fileID: "f4", kind: "function", name: "someFunc", startLine: 1, endLine: 5, code: "function someFunc() {}" })

        return yield* repo.ftsSearchNodes({ query: "" })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(hits).toEqual([])
  })

  test("sanitization: query with embedded quote chars does not crash", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f5", path: "src/sanitize.ts", contentHash: "h5", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n5", fileID: "f5", kind: "function", name: "sanityCheck", startLine: 1, endLine: 5, code: "function sanityCheck() {}" })

        const hits = yield* repo.ftsSearchNodes({ query: "function 'drop table' --" })
        return hits
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(Array.isArray(hits)).toBe(true)
  })

  test("code-graph FTS reflects inserted nodes: unique token in code returns the node", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    const hits = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        yield* repo.putFile({ id: "f6", path: "src/unique.ts", contentHash: "h6", language: "typescript", indexedAt: 1 })
        yield* repo.putNode({ id: "n6", fileID: "f6", kind: "function", name: "zzyzxMarker", startLine: 1, endLine: 5, code: "function zzyzxMarker() { return 42 }" })

        return yield* repo.ftsSearchNodes({ query: "zzyzxMarker" })
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(hits.length).toBe(1)
    expect(hits[0].name).toBe("zzyzxMarker")
  })
})
