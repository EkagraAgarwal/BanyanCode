import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))

const sessionID = SessionV2.ID.make("ses_jev_part_test")
const messageID = SessionV1.MessageID.make("msg_jev_part_test")
const partID = SessionV1.PartID.make("prt_jev_part_test")

const jevPart = (overrides: Partial<SessionV1.JevActivityPart> = {}): SessionV1.JevActivityPart => ({
  id: partID,
  sessionID,
  messageID,
  type: "jev_activity",
  operationID: "op_jev_router_1",
  feature: "router",
  status: "running",
  ...overrides,
})

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "jev-test",
      directory: "/project",
      title: "jev test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  // Target an ASSISTANT message: the TUI renders jev parts only under
  // assistant turns, so a part attached to a user message would be invisible.
  const assistant: SessionV1.Assistant = {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID: SessionV1.MessageID.make("msg_jev_parent_test"),
    modelID: ModelV2.ID.make("model"),
    providerID: ProviderV2.ID.make("provider"),
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const { id: _, sessionID: __, ...messageData } = assistant
  yield* db
    .insert(MessageTable)
    .values({
      id: messageID,
      session_id: sessionID,
      time_created: 0,
      data: messageData,
    })
    .run()
    .pipe(Effect.orDie)
  return db
})

describe("SessionV1.JevActivityPart", () => {
  it.effect("projects durably, upserts by stable part id, and never rolls usage into session cost", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventV2.Service

      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: jevPart({ status: "running" }),
        time: 1,
      })

      const first = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).all().pipe(Effect.orDie)
      expect(first).toHaveLength(1)
      expect(first[0].data).toMatchObject({
        type: "jev_activity",
        operationID: "op_jev_router_1",
        feature: "router",
        status: "running",
      })
      expect(
        Schema.decodeUnknownSync(SessionV1.Part)({
          ...first[0].data,
          id: first[0].id,
          sessionID: first[0].session_id,
          messageID: first[0].message_id,
        }),
      ).toMatchObject({ type: "jev_activity", operationID: "op_jev_router_1", status: "running" })

      // Assistant role association: the part hangs off an assistant message,
      // which is the only role the TUI renders jev parts under.
      expect(first[0].message_id).toBe(messageID)
      const messageRow = yield* db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get().pipe(Effect.orDie)
      expect(messageRow).toBeDefined()
      const info = Schema.decodeUnknownSync(SessionV1.Info)({
        ...messageRow!.data,
        id: messageRow!.id,
        sessionID: messageRow!.session_id,
      })
      expect(info.role).toBe("assistant")

      // Stable operation update: same part id + operationID, terminal status.
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: jevPart({
          status: "completed",
          choice: "model-b",
          summary: "routed to model-b",
          latency: { ms: 128.5 },
          usage: { input: 120, output: 34, cost: 0.0042 },
        }),
        time: 2,
      })

      const rows = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0].data).toMatchObject({
        type: "jev_activity",
        operationID: "op_jev_router_1",
        status: "completed",
        choice: "model-b",
        summary: "routed to model-b",
        latency: { ms: 128.5 },
        usage: { input: 120, output: 34, cost: 0.0042 },
      })

      // Informational usage only: projector.usage() counts step-finish parts.
      const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(session).toMatchObject({
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })

      // Durable event log entry (sync event) exists for replay.
      const log = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.type, "message.part.updated.1"))
        .all()
        .pipe(Effect.orDie)
      expect(log).toHaveLength(2)

      // V1 part events never fabricate V2 session_message rows.
      const v2rows = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(v2rows).toEqual([])
    }),
  )

  it.effect("enforces redacted-field bounds at the schema boundary and the durable commit", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const events = yield* EventV2.Service
      const decode = Schema.decodeUnknownSync(SessionV1.Part)

      expect(() => decode(jevPart({ summary: "x".repeat(401) }))).toThrow()
      expect(() => decode(jevPart({ choice: "x".repeat(121) }))).toThrow()
      expect(() => decode(jevPart({ operationID: "x".repeat(129) }))).toThrow()
      expect(() => decode(jevPart({ feature: "   " }))).toThrow()
      expect(() => decode(jevPart({ status: "done" as unknown as SessionV1.JevActivityStatus }))).toThrow()
      expect(() => decode(jevPart({ latency: { ms: -1 } }))).toThrow()
      // Valid payload still decodes.
      expect(decode(jevPart({ status: "completed", summary: "ok" }))).toMatchObject({ type: "jev_activity" })

      // encode() runs checks inside the durable commit, so an over-bounded
      // payload can never reach the part table or the event log.
      const exit = yield* events
        .publish(SessionV1.Event.PartUpdated, {
          sessionID,
          part: jevPart({ summary: "x".repeat(401) }),
          time: 3,
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      const rows = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).all().pipe(Effect.orDie)
      expect(rows).toEqual([])
    }),
  )
})
