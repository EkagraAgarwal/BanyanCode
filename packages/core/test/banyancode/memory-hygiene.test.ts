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
  const hygieneLayer = Banyan.memoryHygieneLayer
  return { dbLayer, memoryLayer, hygieneLayer }
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

describe("Banyan.MemoryHygiene", () => {
  test("expire flips past-due active entries to expired", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-hygiene-expire.sqlite")
    const { dbLayer, memoryLayer, hygieneLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        const now = Date.now()
        yield* repo.put({
          id: "fresh",
          key: "decision:fresh",
          value: sample({ title: "Fresh decision" }),
          scope: "global",
        })
        yield* repo.put({
          id: "stale",
          key: "decision:stale",
          value: sample({ title: "Stale decision" }),
          scope: "global",
          expiresAt: now - 86_400_000,
        })

        const hygiene = yield* Banyan.MemoryHygiene
        const result = yield* hygiene.expire({ now })
        expect(result.expired).toBe(1)

        const fresh = yield* repo.get("fresh")
        const stale = yield* repo.get("stale")
        expect(fresh?.status).toBe("active")
        expect(stale?.status).toBe("expired")
      }).pipe(
        Effect.provide(hygieneLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("reconcile marks duplicate fingerprints as superseded and prunes old rejected rows", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-hygiene-reconcile.sqlite")
    const { dbLayer, memoryLayer, hygieneLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "first",
          key: "decision:turso",
          value: sample({ title: "Use Turso", body: "Storage backend is Turso." }),
          scope: "global",
        })
        yield* repo.put({
          id: "dupe",
          key: "decision:turso-2",
          value: sample({ title: "Use Turso", body: "Storage backend is Turso." }),
          scope: "global",
        })
        yield* repo.put({
          id: "rejected-old",
          key: "warning:noise-old",
          value: sample({
            kind: "warning",
            title: "Old noise",
            body: "Old noise.",
            confidence: "low",
            importance: "low",
            source: { type: "system" },
          }),
          scope: "global",
        })
        const rejected = yield* repo.get("rejected-old")
        expect(rejected).toBeDefined()
        if (rejected) {
          yield* repo.update({
            id: "rejected-old",
            expectedVersion: rejected.version,
            overrides: { status: "rejected" },
          })
        }

        const hygiene = yield* Banyan.MemoryHygiene
        const result = yield* hygiene.reconcile()
        // The most recently updated row is the survivor; the older duplicate
        // is the one marked superseded.
        expect(result.supersededIds).toContain("first")
        const first = yield* repo.get("first")
        expect(first?.status).toBe("superseded")
        const dupe = yield* repo.get("dupe")
        expect(dupe?.status).toBe("active")

        // Prune by default deletes rejected/expired older than 30 days; in this
        // test the rejected row was just updated, so pruned should be 0.
        expect(result.pruned).toBe(0)
      }).pipe(
        Effect.provide(hygieneLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("prune deletes rejected entries (with zero cutoff so any rejected row qualifies)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-hygiene-prune.sqlite")
    const { dbLayer, memoryLayer, hygieneLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        yield* repo.put({
          id: "to-prune",
          key: "warning:long-rejected",
          value: sample({
            kind: "warning",
            title: "Long-rejected warning",
            body: "Old rejection.",
            confidence: "low",
            importance: "low",
            source: { type: "system" },
          }),
          scope: "global",
        })
        const rejected = yield* repo.get("to-prune")
        if (rejected) {
          yield* repo.update({
            id: "to-prune",
            expectedVersion: rejected.version,
            overrides: { status: "rejected" },
          })
        }

        const hygiene = yield* Banyan.MemoryHygiene
        // olderThanMs=0 means "delete every row matching status ∈ (rejected, expired)".
        const result = yield* hygiene.prune({ olderThanMs: 0 })
        expect(result.deleted).toBeGreaterThanOrEqual(1)
      }).pipe(
        Effect.provide(hygieneLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("sweep runs expire → reconcile → prune in sequence", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-hygiene-sweep.sqlite")
    const { dbLayer, memoryLayer, hygieneLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        const now = Date.now()

        // past-due (will be expired)
        yield* repo.put({
          id: "stale",
          key: "decision:stale",
          value: sample({ title: "Stale decision" }),
          scope: "global",
          expiresAt: now - 86_400_000,
        })
        // fresh duplicate pair (reconcile supersedes older)
        yield* repo.put({
          id: "first",
          key: "decision:dup",
          value: sample({ title: "Dup", body: "Dup body." }),
          scope: "global",
        })
        yield* repo.put({
          id: "second",
          key: "decision:dup-2",
          value: sample({ title: "Dup", body: "Dup body." }),
          scope: "global",
        })
        // rejected entry to be pruned (use olderThanMs=0 so it's deleted)
        yield* repo.put({
          id: "rej",
          key: "warning:noise",
          value: sample({
            kind: "warning",
            title: "Noise",
            body: "Noise.",
            confidence: "low",
            importance: "low",
            source: { type: "system" },
          }),
          scope: "global",
        })
        const rejRow = yield* repo.get("rej")
        if (rejRow) {
          yield* repo.update({
            id: "rej",
            expectedVersion: rejRow.version,
            overrides: { status: "rejected" },
          })
        }

        const hygiene = yield* Banyan.MemoryHygiene
        const result = yield* hygiene.sweep({ olderThanMs: 0 })
        expect(result.ranExpire).toBe(true)
        expect(result.ranReconcile).toBe(true)
        expect(result.ranPrune).toBe(true)
        expect(result.expired).toBeGreaterThanOrEqual(1)
        expect(result.supersededIds.length).toBeGreaterThanOrEqual(1)
        expect(result.pruned).toBeGreaterThanOrEqual(1)
        expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt)
      }).pipe(
        Effect.provide(hygieneLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("sweep respects per-step opt-outs", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-hygiene-sweep-skip.sqlite")
    const { dbLayer, memoryLayer, hygieneLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)

        const repo = yield* Banyan.MemoryRepo
        const now = Date.now()
        yield* repo.put({
          id: "stale",
          key: "decision:stale",
          value: sample({ title: "Stale decision" }),
          scope: "global",
          expiresAt: now - 86_400_000,
        })

        const hygiene = yield* Banyan.MemoryHygiene
        const result = yield* hygiene.sweep({ reconcile: false, prune: false })
        expect(result.ranExpire).toBe(true)
        expect(result.ranReconcile).toBe(false)
        expect(result.ranPrune).toBe(false)
        expect(result.expired).toBe(1)
        expect(result.supersededIds.length).toBe(0)
        expect(result.pruned).toBe(0)
      }).pipe(
        Effect.provide(hygieneLayer),
        Effect.provide(memoryLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
