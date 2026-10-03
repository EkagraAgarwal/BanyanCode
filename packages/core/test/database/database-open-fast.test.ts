import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { STRIP_PATCH_BODIES_BACKFILL_ID } from "@opencode-ai/core/event/compaction"
import { tmpdir } from "../fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | Scope.Scope>, dbPath: string) =>
  Effect.runPromise(Effect.provide(Effect.scoped(effect), Database.layerFromPath(dbPath)))

describe("database open is fast (F3)", () => {
  test("a large freelist and an unapplied backfill marker trigger neither VACUUM nor the backfill", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "fast.sqlite")
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql`CREATE TABLE bloat (id INTEGER PRIMARY KEY, pad TEXT)`)
        yield* db.run(
          sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 8000) INSERT INTO bloat (pad) SELECT hex(randomblob(2000)) FROM n`,
        )
        yield* db.run(sql`DROP TABLE bloat`)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${STRIP_PATCH_BODIES_BACKFILL_ID}`)
      }),
      dbPath,
    )

    const original = process.env.BANYANCODE_DB_MAINTENANCE
    // Isolates the open path itself: the bounded incremental_vacuum is a separate, intentional step.
    process.env.BANYANCODE_DB_MAINTENANCE = "0"
    const started = performance.now()
    const result = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const elapsed = performance.now() - started
        const marker = yield* db.get<{ id: string }>(
          sql`SELECT id FROM migration WHERE id = ${STRIP_PATCH_BODIES_BACKFILL_ID}`,
        )
        const freelist = yield* db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`)
        return { elapsed, marker, freelist: freelist?.freelist_count ?? 0 }
      }),
      dbPath,
    ).finally(() => {
      if (original === undefined) delete process.env.BANYANCODE_DB_MAINTENANCE
      else process.env.BANYANCODE_DB_MAINTENANCE = original
    })

    expect(result.marker).toBeUndefined()
    // A full VACUUM would have emptied the freelist.
    expect(result.freelist).toBeGreaterThan(5000)
    expect(result.elapsed).toBeLessThan(2000)
  })
})
