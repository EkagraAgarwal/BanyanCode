import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const seed = (repo: typeof Banyan.MemoryRepo.Service) =>
  Effect.gen(function* () {
    yield* repo.put({
      id: "pref-bun",
      key: "user:prefer-bun",
      value: {
        kind: "preference",
        title: "Use Bun runtime",
        body: "Project runs on Bun, not Node. Bun is the default runtime.",
        source: { type: "user" },
        confidence: "high",
        importance: "high",
        status: "active",
      },
      tags: ["runtime", "bun"],
      scope: "global",
    })
    yield* repo.put({
      id: "decision-turso",
      key: "decision:db",
      value: {
        kind: "decision",
        title: "Use Turso for storage",
        body: "Storage backend is Turso/libSQL. Embeddings were removed.",
        source: { type: "agent" },
        confidence: "high",
        importance: "high",
        status: "active",
      },
      tags: ["database", "storage"],
      scope: "global",
    })
    yield* repo.put({
      id: "warning-embedding",
      key: "warning:no-embeddings",
      value: {
        kind: "warning",
        title: "Do not use embeddings",
        body: "Memory retrieval must stay FTS/BM25 based. No embeddings.",
        source: { type: "system" },
        confidence: "high",
        importance: "medium",
        status: "active",
      },
      tags: ["memory", "fts"],
      scope: "global",
    })
    yield* repo.put({
      id: "superseded",
      key: "decision:db-old",
      value: {
        kind: "decision",
        title: "Use SQLite only",
        body: "Originally we planned to use raw SQLite.",
        source: { type: "agent" },
        confidence: "low",
        importance: "low",
        status: "superseded",
      },
      tags: [],
      scope: "global",
    })
  })

describe("MemoryRepo.searchRanked", () => {
  test("ranks an exact body match above tangentially-related rows", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-fts-bm25.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo
        yield* seed(repo)

        const { entries, totalHits } = yield* repo.searchRanked({
          query: "Bun runtime",
          limit: 5,
        })
        expect(totalHits).toBeGreaterThan(0)
        expect(entries[0]?.id).toBe("pref-bun")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("filters by status", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-fts-status.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo
        yield* seed(repo)

        const { entries, totalHits } = yield* repo.searchRanked({
          query: "decision",
          limit: 10,
          status: "superseded",
        })
        expect(totalHits).toBe(1)
        expect(entries[0]?.id).toBe("superseded")
        expect(entries[0]?.status).toBe("superseded")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("filters by kind", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-fts-kind.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo
        yield* seed(repo)

        const { entries } = yield* repo.searchRanked({
          query: "storage",
          limit: 10,
          kind: "decision",
        })
        // The Turso decision mentions "storage" — superseded decision does not.
        // With kind=decision + status=active default would exclude superseded.
        expect(entries.find((e) => e.id === "decision-turso")).toBeDefined()
        expect(entries.find((e) => e.id === "superseded")).toBeUndefined()
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("empty query returns zero hits", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-fts-empty.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* Banyan.MemoryRepo
        yield* seed(repo)

        const { entries, totalHits } = yield* repo.searchRanked({ query: "   ", limit: 5 })
        expect(entries).toHaveLength(0)
        expect(totalHits).toBe(0)
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})