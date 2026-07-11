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
  const projectionLayer = Banyan.memoryProjectionLayer
  return { dbLayer, memoryLayer, projectionLayer }
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

describe("Banyan.MemoryProjection", () => {
  test("projectSummary groups active entries by kind", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-projection-summary.sqlite")
    const { dbLayer, memoryLayer, projectionLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "dec1",
          key: "decision:turso",
          value: sample({ title: "Use Turso", kind: "decision" }),
          scope: "global",
        })
        yield* repo.put({
          id: "warn1",
          key: "warning:env",
          value: sample({
            title: "Env fragility",
            kind: "warning",
            confidence: "medium",
            importance: "medium",
            source: { type: "agent" },
            body: "Watch out for env-specific behavior.",
          }),
          scope: "global",
        })
        yield* repo.put({
          id: "todo1",
          key: "todo:cleanup",
          value: sample({
            title: "Cleanup unused indexes",
            kind: "todo",
            confidence: "low",
            importance: "low",
            source: { type: "system" },
            body: "Drop indexes that are unused after the migration.",
          }),
          scope: "global",
        })

        const projection = yield* Banyan.MemoryProjection
        const summary = yield* projection.projectSummary()
        expect(summary.totalActive).toBe(3)
        const kinds = summary.byKind.map((s) => s.kind).sort()
        expect(kinds).toEqual(["decision", "todo", "warning"])
      }).pipe(
        Effect.provide(projectionLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("activeDecisions returns only decision/architecture/constraint kinds", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-projection-decisions.sqlite")
    const { dbLayer, memoryLayer, projectionLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "d1",
          key: "decision:db",
          value: sample({ title: "DB choice", kind: "decision" }),
          scope: "global",
        })
        yield* repo.put({
          id: "a1",
          key: "architecture:layers",
          value: sample({ title: "Layer boundaries", kind: "architecture", body: "Three-tier architecture." }),
          scope: "global",
        })
        yield* repo.put({
          id: "w1",
          key: "warning:noise",
          value: sample({
            title: "Noise warning",
            kind: "warning",
            body: "Just noise.",
            confidence: "low",
            importance: "low",
            source: { type: "system" },
          }),
          scope: "global",
        })

        const projection = yield* Banyan.MemoryProjection
        const result = yield* projection.activeDecisions()
        const keys = result.entries.map((e) => e.key).sort()
        expect(keys).toEqual(["architecture:layers", "decision:db"])
        expect(result.totalActive).toBe(3)
      }).pipe(
        Effect.provide(projectionLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("agentWorkingNotes returns entries attributed to the named agent", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-projection-agent.sqlite")
    const { dbLayer, memoryLayer, projectionLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "b1",
          key: "decision:build-only",
          value: sample({ title: "Build note", kind: "observation", body: "Only build saw this.", source: { type: "agent" }, confidence: "medium", importance: "medium" }),
          scope: "global",
          agentID: "build",
        })
        yield* repo.put({
          id: "o1",
          key: "decision:other-agent",
          value: sample({ title: "Other note", kind: "observation", body: "Other agent saw this.", source: { type: "agent" }, confidence: "medium", importance: "medium" }),
          scope: "global",
          agentID: "orchestrator",
        })

        const projection = yield* Banyan.MemoryProjection
        const notes = yield* projection.agentWorkingNotes({ agentID: "build" })
        expect(notes.agentID).toBe("build")
        expect(notes.entries.length).toBe(1)
        expect(notes.entries[0]?.key).toBe("decision:build-only")
      }).pipe(
        Effect.provide(projectionLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("decisionDigest and warningDigest compress entries into flat digests", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-projection-digest.sqlite")
    const { dbLayer, memoryLayer, projectionLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "d1",
          key: "decision:db",
          value: sample({ title: "Use Turso", kind: "decision", body: "Storage backend is Turso.", importance: "high", confidence: "high" }),
          scope: "global",
        })
        yield* repo.put({
          id: "a1",
          key: "architecture:layers",
          value: sample({ title: "Layer boundaries", kind: "architecture", body: "Three layers." }),
          scope: "global",
        })
        yield* repo.put({
          id: "w1",
          key: "warning:env",
          value: sample({
            title: "Env fragility",
            kind: "warning",
            body: "Watch out for env-specific behavior.",
            confidence: "medium",
            importance: "medium",
            source: { type: "agent" },
          }),
          scope: "global",
        })
        yield* repo.put({
          id: "f1",
          key: "failure:db-migrate",
          value: sample({
            title: "DB migration crash",
            kind: "failure",
            body: "Migration crashed on empty schema.",
            confidence: "high",
            importance: "high",
            source: { type: "agent" },
          }),
          scope: "global",
        })
        yield* repo.put({
          id: "t1",
          key: "todo:cleanup",
          value: sample({
            title: "Cleanup unused indexes",
            kind: "todo",
            body: "Drop unused indexes.",
            source: { type: "system" },
          }),
          scope: "global",
        })

        const projection = yield* Banyan.MemoryProjection
        const dec = yield* projection.decisionDigest()
        expect(dec.items.length).toBe(2)
        const kinds = dec.items.map((i) => i.kind).sort()
        expect(kinds).toEqual(["architecture", "decision"])
        expect(dec.items[0]?.title.length).toBeGreaterThan(0)
        expect(dec.items[0]?.body.length).toBeGreaterThan(0)
        expect(dec.totalActive).toBe(5)

        const warn = yield* projection.warningDigest()
        expect(warn.items.length).toBe(2)
        const warnKinds = warn.items.map((i) => i.kind).sort()
        expect(warnKinds).toEqual(["failure", "warning"])

        const capped = yield* projection.decisionDigest({ maxItems: 1 })
        expect(capped.items.length).toBe(1)
      }).pipe(
        Effect.provide(projectionLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
