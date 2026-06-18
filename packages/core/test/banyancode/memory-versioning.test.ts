import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

describe("Memory versioning", () => {
  test("put assigns version 1 and derives namespace from key", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-versioning.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "a",
          key: "research:react",
          value: { foo: "bar" },
          tags: ["tag1"],
          scope: "global",
          agentID: "agent-123",
        })

        const entry = yield* repo.get("a")
        expect(entry).toBeDefined()
        expect(entry!.version).toBe(1)
        expect(entry!.namespace).toBe("research")
        expect(entry!.agentID).toBe("agent-123")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("put on same id bumps version", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-bump.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        // First put
        yield* repo.put({
          id: "a",
          key: "research:react",
          value: { v: 1 },
          tags: [],
          scope: "global",
          agentID: "agent-1",
        })

        let entry = yield* repo.get("a")
        expect(entry!.version).toBe(1)

        // Second put without agentID - should bump version but retain agent_id
        yield* repo.put({
          id: "a",
          key: "research:react",
          value: { v: 2 },
          tags: [],
          scope: "global",
        })

        entry = yield* repo.get("a")
        expect(entry!.version).toBe(2)
        expect(entry!.agentID).toBe("agent-1") // retained

        // Third put with new agentID
        yield* repo.put({
          id: "a",
          key: "research:react",
          value: { v: 3 },
          tags: [],
          scope: "global",
          agentID: "agent-2",
        })

        entry = yield* repo.get("a")
        expect(entry!.version).toBe(3)
        expect(entry!.agentID).toBe("agent-2") // updated
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("update with matching expectedVersion succeeds", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-update-success.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "a",
          key: "test:key",
          value: { original: true },
          tags: [],
          scope: "global",
        })

        let entry = yield* repo.get("a")
        expect(entry!.version).toBe(1)
        expect(entry!.value).toEqual({ original: true })

        const updated = yield* repo.update({
          id: "a",
          expectedVersion: 1,
          value: { updated: true },
        })

        expect(updated.version).toBe(2)
        expect(updated.value).toEqual({ updated: true })

        entry = yield* repo.get("a")
        expect(entry!.version).toBe(2)
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("update with stale expectedVersion fails", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-stale.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "a",
          key: "test:key",
          value: { original: true },
          tags: [],
          scope: "global",
        })

        const result = yield* Effect.exit(repo.update({
          id: "a",
          expectedVersion: 99,
          value: { updated: true },
        }))

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause) as { _tag: string; expectedVersion?: number; currentVersion?: number }
          expect(error._tag).toBe("StaleWriteError")
          expect(error.expectedVersion).toBe(99)
          expect(error.currentVersion).toBe(1)
        }
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("update on non-existent id returns NotFoundError", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-notfound.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        const result = yield* Effect.exit(repo.update({
          id: "missing",
          expectedVersion: 1,
        }))

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause) as { _tag: string }
          expect(error._tag).toBe("NotFoundError")
        }
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("namespace derivation", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-namespace.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({ id: "1", key: "research:react:hooks", value: {}, tags: [], scope: "global" })
        yield* repo.put({ id: "2", key: "unscoped", value: {}, tags: [], scope: "global" })
        yield* repo.put({ id: "3", key: "scout:deps:api", value: {}, tags: [], scope: "global" })

        const e1 = yield* repo.get("1")
        const e2 = yield* repo.get("2")
        const e3 = yield* repo.get("3")

        expect(e1!.namespace).toBe("research")
        expect(e2!.namespace).toBeUndefined()
        expect(e3!.namespace).toBe("scout")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("legacy unprefixed keys still read back", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-legacy.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        // Manually insert a legacy row (no agent_id, no namespace, version 1)
        yield* db
          .insert(Banyan.MemoryEntriesTable)
          .values({
            id: "legacy-1",
            key: "legacy-key",
            value: { legacy: true },
            context: null,
            tags: [],
            scope: "global",
            session_id: null,
            created_at: 1000,
            expires_at: null,
            agent_id: null,
            version: 1,
            updated_at: 1000,
            namespace: null,
          })
          .run()
          .pipe(Effect.orDie)

        const repo = yield* Banyan.MemoryRepo

        // List should return it
        const entries = yield* repo.list("global")
        expect(entries.length).toBe(1)
        expect(entries[0]!.id).toBe("legacy-1")
        expect(entries[0]!.agentID).toBeUndefined()
        expect(entries[0]!.namespace).toBeUndefined()
        expect(entries[0]!.version).toBe(1)

        // Update it - should bump version but if no agentID provided, agent_id stays null
        const updated = yield* repo.update({
          id: "legacy-1",
          expectedVersion: 1,
          value: { legacy: false },
        })

        expect(updated.version).toBe(2)
        expect(updated.agentID).toBeUndefined() // still null since no agentID passed
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("forgetByKey deletes matching rows and returns count", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory-forgetbykey.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({ id: "1", key: "test:key", value: {}, tags: [], scope: "global" })
        yield* repo.put({ id: "2", key: "test:key", value: {}, tags: [], scope: "global" })
        yield* repo.put({ id: "3", key: "other:key", value: {}, tags: [], scope: "global" })

        const deleted = yield* repo.forgetByKey({ key: "test:key", scope: "global" })
        expect(deleted).toBe(2)

        const remaining = yield* repo.list("global")
        expect(remaining.length).toBe(1)
        expect(remaining[0]!.key).toBe("other:key")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})