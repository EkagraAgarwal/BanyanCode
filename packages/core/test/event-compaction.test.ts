// S1 (event-log compaction) + S2 (patch-body strip) tests.
//
// Real SQLite in tmpdir via Database.layerFromPath (never the repo root).
// Compaction operates on raw rows (no schema validation), so history rows
// are inserted directly; replay mechanics use a small registered sync type.
import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Schema, Stream } from "effect"
import type * as Scope from "effect/Scope"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventV2 } from "@opencode-ai/core/event"
import {
  STRIP_PATCH_BODIES_BACKFILL_ID,
  compactSnapshots,
  stripDiffsPatches,
  stripSnapshotPatchBodies,
} from "@opencode-ai/core/event/compaction"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const TestSync = EventV2.define({
  type: "test.compaction",
  sync: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

const dbOnly = (dbPath: string) => Database.layerFromPath(dbPath)
const withEvents = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  return Layer.mergeAll(dbLayer, EventV2.layer.pipe(Layer.provide(dbLayer)))
}

const run = <R, EL, A, EE>(
  effect: Effect.Effect<A, EE, R | Scope.Scope>,
  layer: Layer.Layer<R, EL>,
): Promise<A> => Effect.runPromise(Effect.provide(Effect.scoped(effect), layer))

const messageEvent = (aggregateID: string, seq: number, messageID: string) => ({
  id: EventV2.ID.create(),
  aggregate_id: aggregateID,
  seq,
  type: "message.updated.1",
  data: { sessionID: aggregateID, info: { id: messageID } },
})

// Raw JSON bodies bypass the V1 schema types; this is intentional (the
// maintenance code never validates, it only reshapes).
const rawData = (value: unknown) => value as (typeof MessageTable.$inferInsert)["data"]
const rawPart = (value: unknown) => value as (typeof PartTable.$inferInsert)["data"]

describe("event compaction (S1)", () => {
  test("keeps latest per entity and removes older intermediates in batches", async () => {
    await using tmp = await tmpdir()
    const layer = dbOnly(path.join(tmp.path, "s1.sqlite"))
    const report = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agg = "ses_compact_a"
        // Event rows FK-reference their aggregate's sequence row.
        yield* db.insert(EventSequenceTable).values({ aggregate_id: agg, seq: 7 }).run()
        yield* db
          .insert(EventTable)
          .values([
            messageEvent(agg, 0, "msg_1"),
            messageEvent(agg, 1, "msg_2"),
            messageEvent(agg, 2, "msg_1"),
            messageEvent(agg, 3, "msg_2"),
            messageEvent(agg, 4, "msg_1"),
            {
              id: EventV2.ID.create(),
              aggregate_id: agg,
              seq: 5,
              type: "message.part.updated.1",
              data: { sessionID: agg, part: { id: "prt_1" }, time: 1 },
            },
            {
              id: EventV2.ID.create(),
              aggregate_id: agg,
              seq: 6,
              type: "message.part.updated.1",
              data: { sessionID: agg, part: { id: "prt_1" }, time: 2 },
            },
            {
              id: EventV2.ID.create(),
              aggregate_id: agg,
              seq: 7,
              type: "session.updated.1",
              data: { sessionID: agg, info: { id: agg } },
            },
          ])
          .run()
        return yield* compactSnapshots(db, { horizonSeqs: 0, batch: 2 })
      }),
      layer,
    )
    expect(report.deletedRows).toBe(4)
    expect(report.batches).toBeGreaterThanOrEqual(2)
    const rows = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.select({ seq: EventTable.seq }).from(EventTable).orderBy(asc(EventTable.seq)).all()
      }),
      layer,
    )
    // Latest per message (3, 4), latest per part (6), session snapshot (7).
    expect(rows.map((row) => row.seq)).toEqual([3, 4, 6, 7])
  })

  test("rows within the sync horizon are untouched", async () => {
    await using tmp = await tmpdir()
    const layer = dbOnly(path.join(tmp.path, "s1h.sqlite"))
    const remaining = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agg = "ses_compact_h"
        yield* db.insert(EventSequenceTable).values({ aggregate_id: agg, seq: 5 }).run()
        yield* db
          .insert(EventTable)
          .values([0, 1, 2, 3, 4, 5].map((seq) => messageEvent(agg, seq, "msg_1")))
          .run()
        yield* compactSnapshots(db, { horizonSeqs: 2 })
        return yield* db.select({ seq: EventTable.seq }).from(EventTable).orderBy(asc(EventTable.seq)).all()
      }),
      layer,
    )
    // maxSeq 5, floor 3: seq 4 (horizon) and seq 5 (latest) survive.
    expect(remaining.map((row) => row.seq)).toEqual([4, 5])
  })

  test("rows without an attributable entity are never deleted", async () => {
    await using tmp = await tmpdir()
    const layer = dbOnly(path.join(tmp.path, "s1u.sqlite"))
    const remaining = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agg = "ses_compact_unknown"
        yield* db.insert(EventSequenceTable).values({ aggregate_id: agg, seq: 2 }).run()
        yield* db
          .insert(EventTable)
          .values([
            {
              id: EventV2.ID.create(),
              aggregate_id: agg,
              seq: 0,
              type: "message.updated.1",
              data: { sessionID: agg, info: {} },
            },
            messageEvent(agg, 1, "msg_1"),
            messageEvent(agg, 2, "msg_1"),
          ])
          .run()
        yield* compactSnapshots(db, { horizonSeqs: 0 })
        return yield* db.select({ seq: EventTable.seq }).from(EventTable).orderBy(asc(EventTable.seq)).all()
      }),
      layer,
    )
    // Seq 0 has no entity key, so it can never be proven superseded.
    expect(remaining.map((row) => row.seq)).toEqual([0, 2])
  })

  test("per-type caps trim oldest horizon-kept rows, never per-entity latest", async () => {
    await using tmp = await tmpdir()
    const layer = dbOnly(path.join(tmp.path, "s1c.sqlite"))
    const remaining = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agg = "ses_compact_cap"
        yield* db.insert(EventSequenceTable).values({ aggregate_id: agg, seq: 3 }).run()
        yield* db
          .insert(EventTable)
          .values([0, 1, 2, 3].map((seq) => messageEvent(agg, seq, "msg_1")))
          .run()
        yield* compactSnapshots(db, { horizonSeqs: 10, maxRowsPerAggregateType: 2 })
        return yield* db.select({ seq: EventTable.seq }).from(EventTable).orderBy(asc(EventTable.seq)).all()
      }),
      layer,
    )
    expect(remaining.map((row) => row.seq)).toEqual([2, 3])
  })

  test("compaction never touches the sequence high-water mark", async () => {
    await using tmp = await tmpdir()
    const layer = withEvents(path.join(tmp.path, "s1s.sqlite"))
    const result = await run(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const agg = EventV2.ID.create()
        for (const text of ["zero", "one", "two"]) yield* events.publish(TestSync, { id: agg, text })
        const report = yield* compactSnapshots(db, {
          compactableTypes: [EventV2.versionedType(TestSync.type, 1)],
          entityOf: () => "singleton",
          horizonSeqs: 0,
        })
        expect(report.deletedRows).toBe(2)
        const retained = yield* db
          .select({ seq: EventTable.seq })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, agg))
          .orderBy(asc(EventTable.seq))
          .all()
        expect(retained.map((row) => row.seq)).toEqual([2])
        const published = yield* events.publish(TestSync, { id: agg, text: "three" })
        expect(published.seq).toBe(3)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, agg))
          .get()
        return sequence?.seq
      }),
      layer,
    )
    expect(result).toBe(3)
  })
})

describe("strip patch bodies (S2)", () => {
  test("stripDiffsPatches removes only FileDiff patch bodies", () => {
    const { value, changed } = stripDiffsPatches({
      summary: {
        diffs: [
          { file: "a.ts", patch: "@@ big", additions: 10, deletions: 2 },
          { file: "b.ts", additions: 1, deletions: 0 },
        ],
      },
      revert: { diff: "keepme" },
      tool: { patch: "not-a-diff", note: "x" },
    })
    expect(changed).toBeTrue()
    expect(value).toEqual({
      summary: { diffs: [{ file: "a.ts", additions: 10, deletions: 2 }, { file: "b.ts", additions: 1, deletions: 0 }] },
      revert: { diff: "keepme" },
      tool: { patch: "not-a-diff", note: "x" },
    })
    expect(stripDiffsPatches(value).changed).toBeFalse()
    // Bare FileDiff arrays (the session.summary_diffs shape) strip too.
    expect(
      stripDiffsPatches([{ file: "a.ts", patch: "@@ big", additions: 10, deletions: 2 }]),
    ).toEqual({ value: [{ file: "a.ts", additions: 10, deletions: 2 }], changed: true })
  })

  test("rewrite strips patch bodies across event/message/part/session rows, idempotently", async () => {
    await using tmp = await tmpdir()
    const layer = dbOnly(path.join(tmp.path, "s2.sqlite"))
    const diffs = [
      { file: "a.ts", patch: "@@ huge", additions: 10, deletions: 2 },
      { file: "b.ts", additions: 1, deletions: 0 },
    ]
    const first = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const projectID = ProjectV2.ID.make("prj_s2")
        const sessionID = SessionSchema.ID.make("ses_s2")
        const messageID = SessionV1.MessageID.make("msg_s2")
        const partID = SessionV1.PartID.make("prt_s2")
        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree: AbsolutePath.make("/tmp/s2"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "s2",
            directory: "/tmp/s2",
            title: "s2",
            version: "test",
            time_created: 1,
            time_updated: 1,
            summary_additions: 11,
            summary_deletions: 2,
            summary_files: 2,
            summary_diffs: diffs,
          })
          .run()
        yield* db
          .insert(MessageTable)
          .values({ id: messageID, session_id: sessionID, time_created: 1, time_updated: 1, data: rawData({ summary: { diffs } }) })
          .run()
        yield* db
          .insert(PartTable)
          .values({
            id: partID,
            message_id: messageID,
            session_id: sessionID,
            time_created: 1,
            time_updated: 1,
            data: rawPart({ extra: { diffs } }),
          })
          .run()
        yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 0 }).run()
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.create(),
            aggregate_id: sessionID,
            seq: 0,
            type: "message.updated.1",
            data: { sessionID, info: { id: messageID, summary: { diffs } } },
          })
          .run()
        return yield* stripSnapshotPatchBodies(db, { batch: 2 })
      }),
      layer,
    )
    expect(first.rewritten).toBe(4)
    expect(first.batches).toBeGreaterThanOrEqual(2)

    const second = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const session = yield* db.select({ diffs: SessionTable.summary_diffs }).from(SessionTable).get()
        expect(session?.diffs).toEqual([
          { file: "a.ts", additions: 10, deletions: 2 },
          { file: "b.ts", additions: 1, deletions: 0 },
        ])
        const message = yield* db.select({ data: MessageTable.data }).from(MessageTable).get()
        expect(JSON.stringify(message?.data)).not.toContain("@@ huge")
        const event = yield* db.select({ data: EventTable.data }).from(EventTable).get()
        expect(JSON.stringify(event?.data)).not.toContain("@@ huge")
        return yield* stripSnapshotPatchBodies(db, { batch: 2 })
      }),
      layer,
    )
    expect(second.rewritten).toBe(0)
  })

  test("explicit backfill records the marker and strips pre-existing rows; open does not run it", async () => {
    await using tmp = await tmpdir()
    const layer = dbOnly(path.join(tmp.path, "s2m.sqlite"))
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        // Opening the DB must not run the backfill (it blocks startup on large DBs).
        const before = yield* db.get<{ id: string }>(
          sql`SELECT id FROM migration WHERE id = ${STRIP_PATCH_BODIES_BACKFILL_ID}`,
        )
        expect(before).toBeUndefined()
        yield* db.insert(EventSequenceTable).values({ aggregate_id: "ses_s2m", seq: 0 }).run()
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.create(),
            aggregate_id: "ses_s2m",
            seq: 0,
            type: "session.updated.1",
            data: {
              sessionID: "ses_s2m",
              info: { summary: { diffs: [{ file: "x.ts", patch: "@@ old", additions: 3, deletions: 1 }] } },
            },
          })
          .run()
        yield* DatabaseMigration.applyCodeBackfills(db)
        const marker = yield* db.get<{ id: string }>(
          sql`SELECT id FROM migration WHERE id = ${STRIP_PATCH_BODIES_BACKFILL_ID}`,
        )
        expect(marker?.id).toBe(STRIP_PATCH_BODIES_BACKFILL_ID)
        const event = yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, "ses_s2m"))
          .get()
        expect(event?.data).toEqual({
          sessionID: "ses_s2m",
          info: { summary: { diffs: [{ file: "x.ts", additions: 3, deletions: 1 }] } },
        })
      }),
      layer,
    )
  })
})

describe("replay after compaction", () => {
  test("strict replay rejects compacted gaps; allowGaps replays and continues", async () => {
    await using tmp = await tmpdir()
    const sourceLayer = withEvents(path.join(tmp.path, "replay-src.sqlite"))
    const retained = await run(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const agg = EventV2.ID.create()
        for (const text of ["zero", "one", "two"]) yield* events.publish(TestSync, { id: agg, text })
        // Simulate S1 having removed the superseded intermediate.
        yield* db.delete(EventTable).where(eq(EventTable.seq, 1)).run()
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, agg))
          .orderBy(asc(EventTable.seq))
          .all()
        return rows.map((row) => ({
          id: row.id,
          aggregateID: row.aggregate_id,
          seq: row.seq,
          type: row.type,
          data: row.data,
        }))
      }),
      sourceLayer,
    )
    expect(retained.map((row) => row.seq)).toEqual([0, 2])

    await using tmpStrict = await tmpdir()
    const strictLayer = withEvents(path.join(tmpStrict.path, "replay-strict.sqlite"))
    const strictExit = await run(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        return yield* events.replayAll(retained).pipe(Effect.exit)
      }),
      strictLayer,
    )
    expect(String(strictExit)).toContain("sequence mismatch")

    await using tmpGap = await tmpdir()
    const gapLayer = withEvents(path.join(tmpGap.path, "replay-gap.sqlite"))
    await run(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const source = yield* events.replayAll(retained, { allowGaps: true })
        expect(source).toBe(retained[0]!.aggregateID)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, retained[0]!.aggregateID))
          .get()
        expect(sequence?.seq).toBe(2)
        // New events continue the fast-forwarded sequence.
        yield* events.replay(
          {
            id: EventV2.ID.create(),
            aggregateID: retained[0]!.aggregateID,
            seq: 3,
            type: retained[0]!.type,
            data: { id: retained[0]!.aggregateID, text: "three" },
          },
          { allowGaps: true },
        )
        // Live tail reads retained + new rows in order (take bounds the
        // otherwise infinite live stream).
        const tail = Array.from(
          yield* events
            .aggregateEvents({ aggregateID: retained[0]!.aggregateID })
            .pipe(Stream.take(3), Stream.runCollect),
        )
        expect(tail.map((entry) => entry.cursor)).toEqual([0, 2, 3].map((seq) => EventV2.Cursor.make(seq)))
      }),
      gapLayer,
    )
  })
})
