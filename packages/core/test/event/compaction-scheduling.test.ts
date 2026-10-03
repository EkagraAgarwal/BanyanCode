import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMaintenance } from "@opencode-ai/core/database/maintenance"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { tmpdir } from "../fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service | Scope.Scope>, dbPath: string) =>
  Effect.runPromise(Effect.provide(Effect.scoped(effect), Database.layerFromPath(dbPath)))

const withEnv = <A, E, R>(env: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
      Object.assign(process.env, env)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

describe("db maintenance scheduling (F2)", () => {
  test("compacts superseded rows once, writes the marker, and is a no-op on an immediate re-run", async () => {
    await using tmp = await tmpdir()
    const total = 30
    const result = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agg = "ses_sched"
        yield* db.insert(EventSequenceTable).values({ aggregate_id: agg, seq: total - 1 }).run()
        yield* db
          .insert(EventTable)
          .values(
            Array.from({ length: total }, (_, seq) => ({
              id: EventV2.ID.create(),
              aggregate_id: agg,
              seq,
              type: "message.updated.1",
              data: { sessionID: agg, info: { id: "msg_1" }, n: seq },
            })),
          )
          .run()
        const first = yield* withEnv(
          { BANYANCODE_EVENT_COMPACT_MAX_ROWS_PER_TYPE: "5", BANYANCODE_EVENT_COMPACT_HORIZON_SEQS: "3" },
          DatabaseMaintenance.run(db, { now: 1_000_000 }),
        )
        const remaining = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, agg)).all()
        const readMarker = db.get<{ time_completed: number }>(
          sql`SELECT time_completed FROM migration WHERE id = ${DatabaseMaintenance.MARKER_ID}`,
        )
        const marker = yield* readMarker
        const second = yield* DatabaseMaintenance.run(db, { now: 1_000_000 + 1000 })
        const markerAfter = yield* readMarker
        const later = yield* DatabaseMaintenance.run(db, { now: 1_000_000 + DatabaseMaintenance.INTERVAL_MS })
        return { first, remaining, marker, second, markerAfter, later }
      }),
      path.join(tmp.path, "sched.sqlite"),
    )

    expect(result.first.ran).toBe(true)
    expect(result.first.compaction?.deletedRows).toBeGreaterThan(0)
    expect(result.remaining.length).toBeLessThan(total)
    expect(result.remaining.map((row) => row.seq)).toContain(total - 1)
    expect(result.marker?.time_completed).toBe(1_000_000)
    expect(result.second.ran).toBe(false)
    expect(result.markerAfter?.time_completed).toBe(1_000_000)
    expect(result.later.ran).toBe(true)
  })
})
