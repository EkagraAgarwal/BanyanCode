/**
 * Regression test for the memory-tool sessionID scoping fix.
 *
 * The four read tools (memory_recall, memory_list, memory_forget, memory_search)
 * used to pass `input.sessionID` directly to the repo. When the LLM omitted
 * `sessionID` from the tool input, the SQL filter became `session_id = ''`,
 * which never matched the canonical session rows that `memory_store` had
 * written using `context.sessionID`.
 *
 * The fix in `packages/core/src/tool/memory.ts` adds `(input, context) =>`
 * to all four read tools and resolves `const sessionID = input.sessionID ??
 * context.sessionID`. This test exercises the same pattern at the repo
 * level to lock in the underlying contract that the read tools now rely on:
 * the `repo.search/list/forgetByKey` calls must be invoked with a
 * non-empty sessionID for `scope: "session"` reads to find rows.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import { randomUUID } from "node:crypto"

process.env.BANYANCODE_ENABLE = "1"

describe("MemoryTools sessionID scoping (regression)", () => {
  test("repo.search with empty sessionID finds zero rows (the bug the fix prevents)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "search.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: randomUUID(),
          key: "test-key",
          value: { foo: "bar" },
          tags: ["regression"],
          scope: "session",
          sessionID: "ses_canonical",
          createdAt: Date.now(),
          agentID: "build",
        })

        // Pre-fix behavior: tool handler passed input.sessionID (undefined)
        // straight to repo.search, producing session_id = ''. Result: 0 rows.
        const preFixResults = yield* repo.search("session", "", "test-key")
        expect(preFixResults.length).toBe(0)

        // Post-fix behavior: tool handler resolves sessionID = input.sessionID ?? context.sessionID.
        // The same call with the canonical sessionID finds the row.
        const postFixResults = yield* repo.search("session", "ses_canonical", "test-key")
        expect(postFixResults.length).toBe(1)
        expect(postFixResults[0].sessionID).toBe("ses_canonical")
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("repo.list with empty sessionID finds zero rows (the bug the fix prevents)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "list.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: randomUUID(),
          key: "session-key",
          value: { v: 1 },
          tags: [],
          scope: "session",
          sessionID: "ses_from_context",
          createdAt: Date.now(),
        })

        const preFixResults = yield* repo.list("session", "")
        expect(preFixResults.length).toBe(0)

        const postFixResults = yield* repo.list("session", "ses_from_context")
        expect(postFixResults.length).toBe(1)
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
