import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { MemoryPayloadV1 } from "@opencode-ai/core/banyancode/memory-payload"
import {
  classifyQuery,
  computeRankSignals,
} from "@opencode-ai/core/banyancode/memory-retrieval"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayers = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const memoryLayer = Banyan.memoryRepoLayer
  const retrievalLayer = Banyan.memoryRetrievalLayer
  return { dbLayer, memoryLayer, retrievalLayer }
}

const sample = (overrides: Partial<MemoryPayloadV1>): MemoryPayloadV1 => ({
  kind: "decision",
  title: "Use Turso",
  body: "Storage backend is Turso/libSQL.",
  source: { type: "user" },
  confidence: "high",
  importance: "high",
  status: "active",
  ...overrides,
})

describe("memory-retrieval", () => {
  test("classifyQuery routes why/rationale to history", () => {
    expect(classifyQuery({ query: "why did we switch storage backends?" }).intent).toBe("history")
  })

  test("classifyQuery routes preference-style to preference", () => {
    expect(
      classifyQuery({ query: "how should I format memory entries?" }).intent,
    ).toBe("preference")
  })

  test("classifyQuery routes continue/resume to continuation", () => {
    expect(classifyQuery({ query: "continue where we left off" }).intent).toBe("continuation")
  })

  test("classifyQuery defaults to code-centric for plain code questions", () => {
    expect(classifyQuery({ query: "Where is auth implemented?" }).intent).toBe("code-centric")
  })

  test("computeRankSignals boosts same-scope entries over cross-scope", () => {
    const base = {
      id: "x",
      key: "k",
      value: sample({}),
      context: undefined,
      tags: [],
      scope: "global" as const,
      sessionID: undefined,
      createdAt: 1_700_000_000_000,
      expiresAt: undefined,
      agentID: "build",
      version: 1,
      updatedAt: 1_700_000_000_000,
      namespace: undefined,
      kind: "decision" as const,
      title: "Use Turso",
      body: "Storage backend is Turso.",
      status: "active" as const,
    }
    const now = base.updatedAt + 86_400_000
    const sameScope = computeRankSignals(base, now, "global")
    const crossScope = computeRankSignals({ ...base, scope: "session" }, now, "global")
    expect(sameScope.scopeMatch).toBeGreaterThan(0)
    expect(crossScope.scopeMatch).toBe(0)
  })
})

describe("Banyan.MemoryRetrieval", () => {
  test("skips retrieval for code-centric queries", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-retrieval-skip.sqlite")
    const { dbLayer, memoryLayer, retrievalLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const retrieval = yield* Banyan.MemoryRetrieval
        const result = yield* retrieval.retrieve({ query: "Where is auth implemented?" })
        expect(result.skipped).toBe(true)
        expect(result.intent).toBe("code-centric")
      }).pipe(
        Effect.provide(retrievalLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("returns ranked hits for history queries", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-retrieval-history.sqlite")
    const { dbLayer, memoryLayer, retrievalLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "decision-turso",
          key: "decision:switch-storage",
          value: sample({ title: "Switch storage", body: "Switched from SQLite to Turso for storage." }),
          scope: "global",
        })
        yield* repo.put({
          id: "observation-noise",
          key: "observation:low-signal",
          value: sample({
            kind: "observation",
            title: "Misc note",
            body: "Some low-signal working note.",
            confidence: "low",
            importance: "low",
            source: { type: "system" },
          }),
          scope: "global",
        })

        const retrieval = yield* Banyan.MemoryRetrieval
        const result = yield* retrieval.retrieve({
          query: "why did we switch storage?",
        })
        expect(result.skipped).toBe(false)
        expect(result.intent).toBe("history")
        expect(result.hits.length).toBeGreaterThan(0)
        const top = result.hits[0]!
        expect(top.entry.key).toBe("decision:switch-storage")
      }).pipe(
        Effect.provide(retrievalLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
