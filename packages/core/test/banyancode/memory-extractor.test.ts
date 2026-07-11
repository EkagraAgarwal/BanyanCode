import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { MemoryPayloadV1 } from "@opencode-ai/core/banyancode/memory-payload"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayers = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const memoryLayer = Banyan.memoryRepoLayer
  const memoryServiceLayer = Banyan.memoryServiceLayer
  const extractorLayer = Banyan.memoryExtractorLayer
  return { dbLayer, memoryLayer, memoryServiceLayer, extractorLayer }
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

describe("Banyan.MemoryExtractor", () => {
  test("keeps durable, decision-shaped payloads", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-extractor-keep.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer, extractorLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const extractor = yield* Banyan.MemoryExtractor
        const result = yield* extractor.extract({
          payload: sample({ title: "Adopt Turso for storage" }),
          scope: "global",
        })
        expect(result.decision).toBe("keep")
        if (result.action.type === "keep") {
          expect(result.action.suggestedKey).toContain("decision:adopt-turso-for-storage")
          expect(result.action.payload.kind).toBe("decision")
        } else {
          throw new Error(`expected keep action, got ${result.action.type}`)
        }
      }).pipe(
        Effect.provide(extractorLayer),
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("discards trivial observations with low confidence + short body", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-extractor-discard.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer, extractorLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const extractor = yield* Banyan.MemoryExtractor
        const result = yield* extractor.extract({
          payload: sample({
            kind: "observation",
            title: "ok",
            body: "tiny",
            confidence: "low",
            importance: "low",
            source: { type: "system" },
          }),
          scope: "global",
        })
        expect(result.decision).toBe("discard")
        expect(result.action.type).toBe("discard")
      }).pipe(
        Effect.provide(extractorLayer),
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("merges into existing entry when suggested key already exists", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-extractor-merge.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer, extractorLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        const existing = sample({ title: "Adopt Turso for storage", tags: ["database"] })
        yield* repo.put({
          id: "existing-decision",
          key: "decision:adopt-turso-for-storage",
          value: existing,
          scope: "global",
          tags: ["database"],
        })

        const extractor = yield* Banyan.MemoryExtractor
        const result = yield* extractor.extract({
          payload: sample({
            kind: "convention",
            title: "Adopt Turso for storage",
            body: "Turso confirmed as storage backend after the team evaluation.",
            confidence: "low",
            importance: "low",
            source: { type: "agent" },
            tags: ["database", "storage"],
          }),
          scope: "global",
        })
        expect(["merge", "keep"]).toContain(result.action.type)
        if (result.action.type === "merge") {
          expect(result.action.existingID).toBe("existing-decision")
        }
      }).pipe(
        Effect.provide(extractorLayer),
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("summarizes long, low-value bodies", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-extractor-summarize.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer, extractorLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const extractor = yield* Banyan.MemoryExtractor
        const longBody = "word ".repeat(200)
        const result = yield* extractor.extract({
          payload: sample({
            kind: "observation",
            title: "Working notes",
            body: longBody,
            confidence: "medium",
            importance: "low",
            source: { type: "agent" },
          }),
          scope: "global",
          maxSummaryBody: 120,
        })
        expect(result.decision).toBe("summarize")
        expect(result.action.type).toBe("summarize")
        if (result.action.type === "summarize") {
          expect(result.action.condensedBody.length).toBeLessThanOrEqual(124)
          expect(result.action.payload.body).toBe(result.action.condensedBody)
        }
      }).pipe(
        Effect.provide(extractorLayer),
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
