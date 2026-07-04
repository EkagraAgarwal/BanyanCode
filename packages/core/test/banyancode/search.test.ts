import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import {
  Search,
  auto as searchAuto,
  manual as searchManual,
  defaultLayer as SearchLayer,
} from "../../src/banyancode/search/index"
import { tmpdir } from "../fixture/tmpdir"

const seedFixture = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service

    yield* repo.putFile({
      id: "file-cb",
      path: "/test/abstract-api-layer.ts",
      contentHash: "hash1",
      language: "typescript",
      indexedAt: Date.now(),
    })
    yield* repo.putNode({
      id: "node-abstract-api-layer",
      fileID: "file-cb",
      kind: "class",
      name: "AbstractApiLayer",
      signature: "class AbstractApiLayer",
      startLine: 1,
      endLine: 10,
      code: "class AbstractApiLayer {}",
    })

    yield* repo.putFile({
      id: "file-sc",
      path: "/test/my_snake_case_module.ts",
      contentHash: "hash2",
      language: "typescript",
      indexedAt: Date.now(),
    })
    yield* repo.putNode({
      id: "node-snake-case-fn",
      fileID: "file-sc",
      kind: "function",
      name: "my_snake_case_function",
      signature: "my_snake_case_function()",
      startLine: 1,
      endLine: 5,
      code: "function my_snake_case_function() {}",
    })

    yield* repo.putFile({
      id: "file-prefix",
      path: "/test/build-service.ts",
      contentHash: "hash3",
      language: "typescript",
      indexedAt: Date.now(),
    })
    yield* repo.putNode({
      id: "node-build-service",
      fileID: "file-prefix",
      kind: "function",
      name: "buildService",
      signature: "buildService(root: string)",
      startLine: 1,
      endLine: 20,
      code: "function buildService(root: string) {}",
    })
    yield* repo.putNode({
      id: "node-build-info",
      fileID: "file-prefix",
      kind: "function",
      name: "buildInfo",
      signature: "buildInfo()",
      startLine: 22,
      endLine: 25,
      code: "function buildInfo() {}",
    })

    yield* repo.putFile({
      id: "file-fuzzy",
      path: "/test/memory.ts",
      contentHash: "hash4",
      language: "typescript",
      indexedAt: Date.now(),
    })
    yield* repo.putNode({
      id: "node-memo",
      fileID: "file-fuzzy",
      kind: "function",
      name: "Memo",
      signature: "Memo()",
      startLine: 1,
      endLine: 5,
      code: "function Memo() {}",
    })
    yield* repo.putNode({
      id: "node-mem0",
      fileID: "file-fuzzy",
      kind: "function",
      name: "Mem0",
      signature: "Mem0()",
      startLine: 7,
      endLine: 10,
      code: "function Mem0() {}",
    })
    yield* repo.putNode({
      id: "node-memory",
      fileID: "file-fuzzy",
      kind: "function",
      name: "Memory",
      signature: "Memory()",
      startLine: 12,
      endLine: 15,
      code: "function Memory() {}",
    })
  })

describe("Search service", () => {
  test("searchExact returns exact name matches with highest score", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.searchExact("buildService")
        expect(results.length).toBe(1)
        expect(results[0]?.node.name).toBe("buildService")
        expect(results[0]?.signals.exact).toBe(true)
        expect(results[0]?.score).toBe(10.0)
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchPrefix returns nodes starting with query", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.searchPrefix("build")
        expect(results.length).toBeGreaterThanOrEqual(2)
        for (const r of results) {
          expect(r.node.name.toLowerCase().startsWith("build")).toBe(true)
          expect(r.signals.prefix).toBe(true)
        }
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchCamelCase matches initials", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.searchCamelCase("AAL")
        expect(results.length).toBe(1)
        expect(results[0]?.node.name).toBe("AbstractApiLayer")
        expect(results[0]?.signals.camelCase).toBe(true)
        expect(results[0]?.score).toBe(4.0)
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchSnakeCase matches underscore-separated names", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.searchSnakeCase("my_snake_case_function")
        expect(results.length).toBe(1)
        expect(results[0]?.node.name).toBe("my_snake_case_function")
        expect(results[0]?.signals.snake_case).toBe(true)
        expect(results[0]?.score).toBe(4.0)
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchFuzzy matches with Levenshtein distance", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.searchFuzzy("Mem0", 2)
        const names = results.map((r) => r.node.name)
        expect(names).toContain("Memo")
        expect(names).toContain("Mem0")
        const mem0Result = results.find((r) => r.node.name === "Mem0")
        expect(mem0Result?.signals.fuzzy).toBe(0)
        expect(mem0Result?.score).toBe(3.0)
        const memoResult = results.find((r) => r.node.name === "Memo")
        expect(memoResult?.signals.fuzzy).toBe(1)
        expect(memoResult?.score).toBe(2.0)
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchBM25 returns ranked results by relevance", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.searchBM25("build", 10)
        expect(results.length).toBeGreaterThan(0)
        expect(results[0]?.node.name).toBe("buildService")
        expect(results[0]?.signals.bm25).toBeDefined()
        expect((results[0]?.score ?? 0) > 0).toBe(true)
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("search (combined) dedups and ranks correctly", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.search("build", {
          modes: ["BM25", "Fuzzy", "Prefix", "Exact"],
          limit: 10,
        })
        const buildServiceResults = results.filter((r) => r.node.name === "buildService")
        expect(buildServiceResults.length).toBe(1)
        const prefixResults = results.filter((r) => r.signals.prefix)
        expect(prefixResults.length).toBeGreaterThan(0)
        const results2 = yield* search.search("build", {
          modes: ["BM25", "Fuzzy", "Prefix", "Exact"],
          limit: 10,
        })
        expect(results.map((r) => r.node.id)).toEqual(results2.map((r) => r.node.id))
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("ranking: exact beats fuzzy beats prefix", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.search("buildService", {
          modes: ["Exact", "Prefix", "Fuzzy", "BM25"],
          limit: 5,
        })
        expect(results[0]?.node.name).toBe("buildService")
        expect(results[0]?.signals.exact).toBe(true)
        expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0)
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchQualified matches last segment of qualified names", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const results = yield* search.searchQualified("AbstractApiLayer")
        expect(results.length).toBe(0)
        const results2 = yield* search.searchQualified("Test.buildService")
        expect(results2.length).toBe(1)
        expect(results2[0]?.node.name).toBe("buildService")
        expect(results2[0]?.signals.qualified).toBe(true)
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("searchAuto cascade locks ordering: exact match outranks fuzzy for known input", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const results = yield* searchAuto("buildService")
        expect(results.length).toBeGreaterThan(0)
        expect(results[0]?.node.name).toBe("buildService")
        expect(results[0]?.signals.exact).toBe(true)
        const exactResult = results.find((r) => r.node.name === "buildService")!
        const fuzzyOnly = results.filter((r) => r.signals.fuzzy !== undefined && !r.signals.exact)
        for (const f of fuzzyOnly) {
          expect(exactResult.score).toBeGreaterThan(f.score)
        }
        const exactIdx = results.findIndex((r) => r.signals.exact)
        const fuzzyOnlyIdx = results.findIndex((r) => r.signals.fuzzy !== undefined && !r.signals.exact)
        if (exactIdx >= 0 && fuzzyOnlyIdx >= 0) {
          expect(exactIdx).toBeLessThan(fuzzyOnlyIdx)
        }
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("search with mode: 'auto' cascades through all modes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const search = yield* Search.Service
        const explicit = yield* search.search("buildService", { mode: "auto" })
        const implicit = yield* search.search("buildService")
        expect(explicit.map((r) => r.node.id)).toEqual(implicit.map((r) => r.node.id))
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("search with mode: 'manual' runs only the selected mode", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        yield* seedFixture()
        const results = yield* searchManual("buildService", "Exact")
        expect(results.length).toBeGreaterThan(0)
        for (const r of results) {
          expect(r.signals.exact).toBe(true)
        }
      }).pipe(Effect.provide(SearchLayer), Effect.provide(CodegraphRepo.defaultLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
