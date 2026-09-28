import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import type { ModelMessage } from "ai"
import { MessageV2 } from "@/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { JevActivity } from "@/session/jev-activity"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

// Real Session.updatePart / JevActivity integration: it.instance provides the
// tmpdir instance fixture; Database.defaultLayer is the test DB configured by
// test/preload.ts (OPENCODE_DB=:memory:).
const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Database.defaultLayer))

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")

function userInfo(id: string): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(id: string, parentID: string): SessionV1.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: ModelV2.ID.make(model.api.id),
    providerID: model.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

// Markers chosen so any accidental replay (model input) or fabricated provider
// tool call is visible in the serialized ModelMessage[] output.
function jevPart(messageID: string, status: SessionV1.JevActivityStatus): SessionV1.Part {
  return {
    ...basePart(messageID, "p-jev"),
    type: "jev_activity",
    operationID: "op_jev_secret_1",
    feature: "router",
    status,
    choice: "JEV_CHOICE_MARKER",
    summary: "JEV_SUMMARY_MARKER",
    latency: { ms: 42 },
    usage: { input: 11, output: 7, cost: 0.001 },
  }
}

const MARKERS = ["jev_activity", "op_jev_secret_1", "JEV_CHOICE_MARKER", "JEV_SUMMARY_MARKER", "router"]

function toolParts(result: ModelMessage[]) {
  return result.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type.startsWith("tool")) : [],
  )
}

describe("session.message-v2 jev_activity safety", () => {
  // jev_activity parts are UI-only: they must never reach provider input.
  test("drops jev_activity from assistant model input without replaying or fabricating tool calls", async () => {
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo("msg_u1"),
        parts: [{ ...basePart("msg_u1", "p1"), type: "text", text: "hello" }],
      },
      {
        info: assistantInfo("msg_a1", "msg_u1"),
        parts: [
          { ...basePart("msg_a1", "p2"), type: "text", text: "assistant reply" },
          jevPart("msg_a1", "completed"),
        ],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const serialized = JSON.stringify(result)

    // The assistant text survives; the jev part never reaches the provider.
    expect(serialized).toContain("assistant reply")
    for (const marker of MARKERS) expect(serialized).not.toContain(marker)
    // No fabricated provider tool call derived from the jev part.
    expect(toolParts(result)).toEqual([])
    // No empty/duplicated turns were created by the extra part.
    expect(result).toHaveLength(2)
    expect(result.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  test("drops jev_activity from user messages and keeps the turn single", async () => {
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo("msg_u2"),
        parts: [
          { ...basePart("msg_u2", "p1"), type: "text", text: "user text" },
          jevPart("msg_u2", "running"),
        ],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("user text")
    for (const marker of MARKERS) expect(serialized).not.toContain(marker)
    expect(toolParts(result)).toEqual([])
    expect(result).toHaveLength(1)
    const user = result[0] as Extract<ModelMessage, { role: "user" }>
    expect(Array.isArray(user.content) && user.content.every((part) => part.type === "text")).toBe(true)
  })

  test("a jev-only assistant turn converts to no model message at all", async () => {
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo("msg_a2", "msg_u2"),
        parts: [jevPart("msg_a2", "running")],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    expect(result).toEqual([])
  })
})

describe("JevActivity publisher through the real Session service", () => {
  const isJev = (part: SessionV1.Part): part is SessionV1.JevActivityPart => part.type === "jev_activity"

  it.instance("publishes running → terminal onto an existing assistant message via Session.updatePart", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      const sid = created.id

      const userID = MessageID.ascending()
      yield* session.updateMessage({
        id: userID,
        sessionID: sid,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID, modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)

      const assistantID = MessageID.ascending()
      yield* session.updateMessage({
        id: assistantID,
        sessionID: sid,
        role: "assistant",
        time: { created: Date.now() },
        parentID: userID,
        modelID: ModelV2.ID.make(model.api.id),
        providerID: model.providerID,
        mode: "build",
        agent: "test",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } satisfies SessionV1.Assistant)

      // Direct publisher API: what an integration calls by hand.
      const direct = yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: sid,
        messageID: assistantID,
        type: "jev_activity",
        operationID: "op_jev_direct",
        feature: "router",
        status: "running",
      } satisfies SessionV1.JevActivityPart)
      expect(direct.type).toBe("jev_activity")

      // Production helper: verifies the assistant target, publishes `running`
      // through Session.updatePart, and keeps ONE stable part id for the
      // running → terminal transition.
      const jev = yield* JevActivity.start({
        sessionID: sid,
        messageID: assistantID,
        operationID: "op_jev_helper",
        feature: "command-gate",
      })

      const running = yield* session.messages({ sessionID: sid })
      const assistant = running.find((item) => item.info.id === assistantID)
      expect(assistant?.info.role).toBe("assistant")
      const runningJev = (assistant?.parts ?? []).filter(isJev)
      expect(runningJev).toHaveLength(2)
      expect(runningJev.find((part) => part.id === jev.partID)).toMatchObject({
        type: "jev_activity",
        status: "running",
        operationID: "op_jev_helper",
        feature: "command-gate",
        messageID: assistantID,
      })
      // Assistant role association: no jev row on the user turn (invisible in
      // the TUI, which only renders jev parts under assistant messages).
      const user = running.find((item) => item.info.id === userID)
      expect((user?.parts ?? []).some((part) => part.type === "jev_activity")).toBe(false)

      const finished = yield* jev.finish({
        status: "completed",
        choice: "allow",
        summary: "gate allowed",
        usage: { input: 0, output: 0 },
      })
      expect(finished.status).toBe("completed")

      const after = yield* session.messages({ sessionID: sid })
      const jevParts = after.flatMap((item) => item.parts.filter(isJev))
      // Stable part id: the handle's row upserted in place — still two rows.
      expect(jevParts).toHaveLength(2)
      const terminal = jevParts.find((part) => part.id === jev.partID)
      expect(terminal).toMatchObject({
        type: "jev_activity",
        status: "completed",
        operationID: "op_jev_helper",
        choice: "allow",
        summary: "gate allowed",
        messageID: assistantID,
      })
      expect(terminal?.latency?.ms).toBeGreaterThanOrEqual(0)
      const finalAssistant = after.find((item) => item.info.id === assistantID)
      expect(finalAssistant?.parts.filter(isJev).map((part) => part.id)).toContain(jev.partID)
    }),
  )

  it.instance("rejects non-assistant targets and over-redacted terminal fields", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      const sid = created.id

      const userID = MessageID.ascending()
      yield* session.updateMessage({
        id: userID,
        sessionID: sid,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID, modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)

      // Existing user message → typed failure, nothing published.
      const userExit = yield* JevActivity.start({
        sessionID: sid,
        messageID: userID,
        operationID: "op_jev_user",
        feature: "router",
      }).pipe(Effect.exit)
      expect(userExit._tag).toBe("Failure")
      expect(String(userExit)).toContain("JevActivityTargetError")

      // Missing message → typed failure.
      const missingExit = yield* JevActivity.start({
        sessionID: sid,
        messageID: MessageID.ascending(),
        operationID: "op_jev_missing",
        feature: "router",
      }).pipe(Effect.exit)
      expect(missingExit._tag).toBe("Failure")
      expect(String(missingExit)).toContain("JevActivityTargetError")

      const assistantID = MessageID.ascending()
      yield* session.updateMessage({
        id: assistantID,
        sessionID: sid,
        role: "assistant",
        time: { created: Date.now() },
        parentID: userID,
        modelID: ModelV2.ID.make(model.api.id),
        providerID: model.providerID,
        mode: "build",
        agent: "test",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } satisfies SessionV1.Assistant)

      // Over-redacted summary fails typed BEFORE the durable commit; the part
      // stays `running` and nothing over-bound is ever stored.
      const jev = yield* JevActivity.start({
        sessionID: sid,
        messageID: assistantID,
        operationID: "op_jev_bounds",
        feature: "router",
      })
      const badExit = yield* jev.finish({ status: "completed", summary: "x".repeat(401) }).pipe(Effect.exit)
      expect(badExit._tag).toBe("Failure")
      expect(String(badExit)).toContain("JevActivityTargetError")

      const messages = yield* session.messages({ sessionID: sid })
      const parts = messages.flatMap((item) => item.parts.filter(isJev))
      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({ id: jev.partID, status: "running" })
    }),
  )
})
