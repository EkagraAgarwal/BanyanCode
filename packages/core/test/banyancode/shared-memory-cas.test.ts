/**
 * Regression test for the shared-memory conditional-write path.
 *
 * Pre-fix, `shared_memory` with `op: "write" + expectedVersion: N` did a
 * non-atomic `repo.get` then `repo.update`. The JS-level version check
 * raced with concurrent writers; a second writer could mutate the row
 * between the get and the update, the tool's check passed against the
 * stale read, and the tool's `Effect.mapError` silently swallowed the
 * repo's resulting `StaleWriteError` as a generic `ToolFailure`. The
 * structured `ok: false, stale_write` response shape was unreachable for
 * the actual race.
 *
 * The fix:
 *  - Drop the redundant `repo.get`.
 *  - Call `repo.update` directly; the repo's `db.transaction` is atomic.
 *  - Translate the typed `StaleWriteError`/`NotFoundError` to the API's
 *    structured response shapes (`stale_write`, fall-through-to-put).
 *
 * These tests verify the repo's atomic CAS holds under concurrent writers
 * (the layer that the tool now relies on). The translation-layer coverage
 * lives in the production tool handler — exercising it would require a
 * full ToolRegistry settlement which has its own setup overhead and is
 * covered by the broader settlement test suite.
 */

import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayers = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
  return { dbLayer, memoryLayer }
}

describe("SharedMemory (MemoryRepo) CAS path (regression)", () => {
  test("update with matching expectedVersion succeeds and bumps version", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "cas-match.sqlite")
    const { dbLayer, memoryLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "row-cas-match",
          key: "test-key",
          value: "v1",
          tags: [],
          scope: "global",
          createdAt: Date.now(),
        })

        const updated = yield* repo
          .update({
            id: "row-cas-match",
            expectedVersion: 1,
            value: "v2",
            agentID: "build",
          })

        expect(updated.version).toBe(2)
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("update with stale expectedVersion atomically fails with StaleWriteError", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "cas-stale.sqlite")
    const { dbLayer, memoryLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "row-cas-stale",
          key: "test-key",
          value: "v1",
          tags: [],
          scope: "global",
          createdAt: Date.now(),
        })
        // Concurrent writer bumps version to 2.
        yield* repo.update({
          id: "row-cas-stale",
          expectedVersion: 1,
          value: "v2",
          agentID: "other-writer",
        })

        // Stale update with expectedVersion=1 should fail atomically.
        const exit = yield* repo
          .update({
            id: "row-cas-stale",
            expectedVersion: 1,
            value: "v3",
            agentID: "us",
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as
            | { _tag?: string; expectedVersion?: number; currentVersion?: number }
            | undefined
          expect(err).toBeDefined()
          expect(err?._tag).toBe("StaleWriteError")
          expect(err?.expectedVersion).toBe(1)
          expect(err?.currentVersion).toBe(2)
        }
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("two concurrent updaters: only one wins, the other surfaces StaleWriteError", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "cas-concurrent.sqlite")
    const { dbLayer, memoryLayer } = buildLayers(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        const repo = yield* Banyan.MemoryRepo

        yield* repo.put({
          id: "row-concurrent",
          key: "test-key",
          value: "v1",
          tags: [],
          scope: "global",
          createdAt: Date.now(),
        })

        // Race two updaters against the same expectedVersion. SQLite's
        // serialized writes guarantee one wins and the other loses with
        // a StaleWriteError. The row ends at version 2 (or 3, depending
        // on commit order), but the value text reflects whichever
        // updater won.
        const updates = yield* Effect.all(
          [
            repo
              .update({
                id: "row-concurrent",
                expectedVersion: 1,
                value: "from-A",
                agentID: "A",
              })
              .pipe(Effect.exit),
            repo
              .update({
                id: "row-concurrent",
                expectedVersion: 1,
                value: "from-B",
                agentID: "B",
              })
              .pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )

        const winners = updates.filter((e) => Exit.isSuccess(e))
        const losers = updates.filter(Exit.isFailure)
        expect(winners.length).toBe(1)
        expect(losers.length).toBe(1)

        const finalRow = yield* repo.get("row-concurrent")
        expect(finalRow?.version).toBe(2)

        if (Exit.isFailure(losers[0])) {
          const err = Option.getOrUndefined(Cause.findErrorOption(losers[0].cause)) as
            | { _tag?: string }
            | undefined
          expect(err?._tag).toBe("StaleWriteError")
        }
      }).pipe(Effect.provide(memoryLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
