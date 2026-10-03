import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { RepositoryIntelligence, defaultLayer as repositoryIntelligenceDefaultLayer } from "../../src/banyancode/repository-intelligence"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

const seedFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    yield* repo.putFile({ id: "file-1", path: "src/calc.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
    yield* repo.putNode({ id: "fn-calculate", fileID: "file-1", kind: "function", name: "calculate", signature: "calculate(x: number)", startLine: 1, endLine: 5, code: "function calculate(x) {}" })
    yield* repo.putFile({ id: "file-2", path: "src/other.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
    yield* repo.putNode({ id: "fn-other", fileID: "file-2", kind: "function", name: "otherThing", signature: "otherThing()", startLine: 1, endLine: 3, code: "function otherThing() {}" })
  })

const testLayer = Layer.mergeAll(
  repositoryIntelligenceDefaultLayer,
  CodegraphRepo.defaultLayer,
)

// Full-projection loads are the ones with no `name` filter: the shared
// context load is searchNodesLight({ limit: 100000 }), while the resolver's
// targeted lookups always pass { name }.
const fullLightLoads = (spy: ReturnType<typeof spyOn>): number =>
  spy.mock.calls.filter((args: readonly unknown[]) => (args[0] as { name?: string } | undefined)?.name === undefined).length

describe("RepositoryIntelligence query-context cache (C2/G2)", () => {
  test("second query within the same graphVersion performs no listAllFiles/searchNodesLight reload", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        yield* CodegraphRepo.Service.pipe(Effect.flatMap((repo) => repo.bumpVersion({})))
        const repo = yield* CodegraphRepo.Service
        const ri = yield* RepositoryIntelligence.Service

        const listFilesSpy = spyOn(repo, "listAllFiles")
        const lightSpy = spyOn(repo, "searchNodesLight")
        try {
          const first = yield* ri.query({ query: "calculate" })
          expect(first.symbols.length).toBeGreaterThan(0)
          expect(listFilesSpy).toHaveBeenCalledTimes(1)
          expect(fullLightLoads(lightSpy)).toBe(1)

          const second = yield* ri.query({ query: "calculate" })
          expect(second.symbols.map((n) => n.id)).toEqual(first.symbols.map((n) => n.id))
          // No rebuild: still exactly one full files scan and one full
          // light projection across both calls (getMeta alone re-checks).
          expect(listFilesSpy).toHaveBeenCalledTimes(1)
          expect(fullLightLoads(lightSpy)).toBe(1)
        } finally {
          listFilesSpy.mockRestore()
          lightSpy.mockRestore()
        }
      }).pipe(
        Effect.provide(testLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("a mutation that bumps graphVersion rebuilds the context and serves the new graph", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        yield* CodegraphRepo.Service.pipe(Effect.flatMap((repo) => repo.bumpVersion({})))
        const repo = yield* CodegraphRepo.Service
        const ri = yield* RepositoryIntelligence.Service

        const listFilesSpy = spyOn(repo, "listAllFiles")
        const lightSpy = spyOn(repo, "searchNodesLight")
        try {
          const before = yield* ri.query({ query: "newHelper" })
          expect(before.symbols.map((n) => n.name)).not.toContain("newHelper")
          expect(listFilesSpy).toHaveBeenCalledTimes(1)

          yield* repo.putFile({ id: "file-new", path: "src/new.ts", contentHash: "h3", language: "typescript", indexedAt: 3 })
          yield* repo.putNode({ id: "fn-new", fileID: "file-new", kind: "function", name: "newHelper", signature: "newHelper()", startLine: 1, endLine: 3, code: "function newHelper() {}" })
          yield* repo.bumpVersion({})

          const after = yield* ri.query({ query: "newHelper" })
          expect(after.symbols.map((n) => n.name)).toContain("newHelper")
          // Exactly one rebuild for the version bump — no more, no less.
          expect(listFilesSpy).toHaveBeenCalledTimes(2)
          expect(fullLightLoads(lightSpy)).toBe(2)
        } finally {
          listFilesSpy.mockRestore()
          lightSpy.mockRestore()
        }
      }).pipe(
        Effect.provide(testLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("concurrent callers share one rebuild (single-flight)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        yield* CodegraphRepo.Service.pipe(Effect.flatMap((repo) => repo.bumpVersion({})))
        const repo = yield* CodegraphRepo.Service
        const ri = yield* RepositoryIntelligence.Service

        const listFilesSpy = spyOn(repo, "listAllFiles")
        const lightSpy = spyOn(repo, "searchNodesLight")
        try {
          const results = yield* Effect.all(
            Array.from({ length: 8 }, () => ri.query({ query: "calculate" })),
            { concurrency: "unbounded" },
          )
          for (const ctx of results) {
            expect(ctx.symbols.length).toBeGreaterThan(0)
          }
          const firstIDs = results[0]!.symbols.map((n) => n.id)
          for (const ctx of results) {
            expect(ctx.symbols.map((n) => n.id)).toEqual(firstIDs)
          }
          expect(listFilesSpy).toHaveBeenCalledTimes(1)
          expect(fullLightLoads(lightSpy)).toBe(1)
        } finally {
          listFilesSpy.mockRestore()
          lightSpy.mockRestore()
        }
      }).pipe(
        Effect.provide(testLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
