import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

describe("MemoryRepo", () => {
  test("round-trip entries across global and session scopes", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "memory.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        const globalEntry = {
          id: "global-1",
          key: "test-key",
          value: { foo: "bar" },
          tags: ["tag1"],
          scope: "global" as const,
          createdAt: Date.now(),
        }
        yield* repo.put(globalEntry)

        const sessionEntry = {
          id: "session-1",
          key: "session-key",
          value: { session: "data" },
          tags: ["session-tag"],
          scope: "session" as const,
          sessionID: "session-abc",
          createdAt: Date.now(),
        }
        yield* repo.put(sessionEntry)

        const retrievedGlobal = yield* repo.get("global-1")
        expect(retrievedGlobal).toEqual({
          ...globalEntry,
          context: undefined,
          expiresAt: undefined,
          agentID: undefined,
          version: 1,
          updatedAt: retrievedGlobal!.updatedAt,
          namespace: undefined,
        })

        const retrievedSession = yield* repo.get("session-1")
        expect(retrievedSession).toEqual({
          ...sessionEntry,
          context: undefined,
          expiresAt: undefined,
          agentID: undefined,
          version: 1,
          updatedAt: retrievedSession!.updatedAt,
          namespace: undefined,
        })

        const globalList = yield* repo.list("global")
        expect(globalList.length).toBe(1)
        expect(globalList[0]?.id).toBe("global-1")

        const sessionList = yield* repo.list("session", "session-abc")
        expect(sessionList.length).toBe(1)
        expect(sessionList[0]?.id).toBe("session-1")

        const searchResults = yield* repo.search("session", "session-abc", "session-key")
        expect(searchResults.length).toBe(1)
        expect(searchResults[0]?.id).toBe("session-1")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("vacuum removes expired entries", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "vacuum.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        const expiredEntry = {
          id: "expired-1",
          key: "expired-key",
          value: { old: true },
          tags: [] as string[],
          scope: "global" as const,
          createdAt: Date.now() - 10000,
          expiresAt: Date.now() - 5000,
        }
        yield* repo.put(expiredEntry)

        const validEntry = {
          id: "valid-1",
          key: "valid-key",
          value: { fresh: true },
          tags: [] as string[],
          scope: "global" as const,
          createdAt: Date.now(),
          expiresAt: Date.now() + 10000,
        }
        yield* repo.put(validEntry)

        const removed = yield* repo.vacuum()
        expect(removed).toBe(1)

        const expiredStillExists = yield* repo.get("expired-1")
        expect(expiredStillExists).toBeUndefined()

        const validStillExists = yield* repo.get("valid-1")
        expect(validStillExists).toBeDefined()
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("forget removes an entry", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "forget.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)

        const repo = yield* Banyan.MemoryRepo

        const entry = {
          id: "to-delete",
          key: "delete-key",
          value: { delete: true },
          tags: [] as string[],
          scope: "global" as const,
          createdAt: Date.now(),
        }
        yield* repo.put(entry)

        const exists = yield* repo.get("to-delete")
        expect(exists).toBeDefined()

        yield* repo.forget("to-delete")

        const afterDelete = yield* repo.get("to-delete")
        expect(afterDelete).toBeUndefined()
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
