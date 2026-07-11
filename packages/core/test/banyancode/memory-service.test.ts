import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { MemoryPayloadV1 } from "@opencode-ai/core/banyancode/memory-payload"

process.env.BANYANCODE_ENABLE = "1"

const samplePayload = (kind: MemoryPayloadV1["kind"], title: string, body: string): MemoryPayloadV1 => ({
  kind,
  title,
  body,
  source: { type: "agent" },
  confidence: "high",
  importance: "medium",
  status: "active",
})

const buildLayers = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const memoryLayer = Banyan.memoryRepoLayer
  const memoryServiceLayer = Banyan.memoryServiceLayer
  return { dbLayer, memoryLayer, memoryServiceLayer }
}

describe("Banyan.MemoryService — emitCandidate / promote / reject / listCandidates", () => {
  test("emitCandidate writes status=pending and drains through the events queue", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-service-emit.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const service = yield* Banyan.MemoryService
        const events = service.events()
        const received: Array<{ type: string; properties: any }> = []
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            while (true) {
              const ev = yield* Queue.take(events)
              received.push(ev as any)
            }
          }).pipe(Effect.catchCause(() => Effect.void)),
        )

        const entry = yield* service.emitCandidate({
          key: "user:prefer-bun",
          value: samplePayload("preference", "Use Bun runtime", "Project runs on Bun, not Node."),
          scope: "global",
          tags: ["runtime"],
          agentID: "build",
        })
        expect(entry.id).toMatch(/^candidate:/)
        expect(entry.status).toBe("pending")

        yield* Effect.sleep(20)
        const types = received.map((r) => r.type)
        expect(types).toContain("banyancode.memory.candidate_emitted")
      }).pipe(
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("promote flips status to active and supersedes a matching active entry", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-service-promote.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const service = yield* Banyan.MemoryService
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "active-old",
          key: "decision:db",
          value: samplePayload("decision", "Use SQLite", "Was on SQLite."),
          scope: "global",
        })

        const cand = yield* service.emitCandidate({
          key: "decision:db",
          value: samplePayload("decision", "Use SQLite", "Was on SQLite. Now we switched to Turso."),
          scope: "global",
        })

        const { entry, supersededIds } = yield* service.promote({
          id: cand.id,
          expectedVersion: cand.version,
        })

        expect(entry.status).toBe("active")
        expect(entry.version).toBeGreaterThan(cand.version)
        expect(supersededIds).toContain("active-old")

        const oldEntry = yield* repo.get("active-old")
        expect(oldEntry?.status).toBe("superseded")
      }).pipe(
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("promote with skipSupersede=true leaves matching actives untouched", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-service-promote-skip.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const service = yield* Banyan.MemoryService
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "active-old",
          key: "decision:keep",
          value: samplePayload("decision", "Keep dual-write", "Write to both backends for safety."),
          scope: "global",
        })

        const cand = yield* service.emitCandidate({
          key: "decision:keep",
          value: samplePayload("decision", "Keep dual-write", "Yet another round, same fact."),
          scope: "global",
        })

        const { entry, supersededIds } = yield* service.promote({
          id: cand.id,
          expectedVersion: cand.version,
          skipSupersede: true,
        })

        expect(entry.status).toBe("active")
        expect(supersededIds.length).toBe(0)

        const oldEntry = yield* repo.get("active-old")
        expect(oldEntry?.status).toBe("active")
      }).pipe(
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("reject flips status to rejected", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-service-reject.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const service = yield* Banyan.MemoryService
        const cand = yield* service.emitCandidate({
          key: "warning:noisy",
          value: samplePayload("warning", "Noisy warning", "Not actually a real warning."),
          scope: "global",
        })

        const rejected = yield* service.reject({ id: cand.id, expectedVersion: cand.version })
        expect(rejected.status).toBe("rejected")

        const listed = yield* service.listCandidates({ status: "rejected" })
        expect(listed.find((e) => e.id === cand.id)).toBeDefined()

        const listedActive = yield* service.listCandidates({ status: "active" })
        expect(listedActive.find((e) => e.id === cand.id)).toBeUndefined()
      }).pipe(
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("listCandidates default status=pending", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-service-list.sqlite")
    const { dbLayer, memoryLayer, memoryServiceLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const service = yield* Banyan.MemoryService
        const repo = yield* Banyan.MemoryRepo

        yield* service.emitCandidate({
          key: "decision:a",
          value: samplePayload("decision", "Decision A", "Body A."),
          scope: "global",
        })
        yield* service.emitCandidate({
          key: "decision:b",
          value: samplePayload("decision", "Decision B", "Body B."),
          scope: "global",
        })
        yield* repo.put({
          id: "active-c",
          key: "decision:c",
          value: samplePayload("decision", "Decision C", "Body C."),
          scope: "global",
        })

        const pending = yield* service.listCandidates()
        expect(pending.length).toBe(2)
        pending.forEach((e) => expect(e.status).toBe("pending"))

        const active = yield* service.listCandidates({ status: "active" })
        expect(active.length).toBe(1)
        expect(active[0]?.id).toBe("active-c")
      }).pipe(
        Effect.provide(memoryServiceLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
