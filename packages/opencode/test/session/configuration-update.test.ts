import { beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Layer } from "effect"
import type { ModelMessage } from "ai"
import { Session as SessionNs } from "@/session/session"
import { SessionEffort } from "@/session/effort"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import type { Plugin } from "@/plugin"
import type { RuntimeFlags } from "@/effect/runtime-flags"

import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Database.defaultLayer))

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

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

const providerID = ProviderV2.ID.make("test")

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
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

function userText(messageID: string, text: string): SessionV1.WithParts {
  return {
    info: userInfo(messageID),
    parts: [{ ...basePart(messageID, "p1"), type: "text", text }] as SessionV1.Part[],
  }
}

function marker(messageID: string, effort: string): SessionV1.WithParts {
  return {
    info: userInfo(messageID),
    parts: [{ ...basePart(messageID, "p1"), type: "configuration_update", reasoning: { effort } }] as SessionV1.Part[],
  }
}

const loweredMarker = (effort: string): ModelMessage => ({
  role: "user",
  content: [
    {
      type: "text",
      text: "",
      providerOptions: {
        configurationUpdate: { type: "configuration_update", reasoning: { effort } },
      },
    },
  ],
})

beforeEach(() => {
  SessionEffort.resetEffortState()
})

const plugin = {
  trigger: ((_name: unknown, _input: unknown, output: unknown) =>
    Effect.succeed(output)) as Plugin.Interface["trigger"],
  list: () => Effect.succeed([]),
  init: () => Effect.void,
}

const flags = { outputTokenMax: undefined, client: "test" } as RuntimeFlags.Info

describe("session.effort isConfigurationUpdateEligible (WS4a)", () => {
  test.each([
    ["gpt-6", true],
    ["gpt-6-astra", true],
    ["gpt-6-sol", true],
    ["gpt-6.1", true],
    ["gpt-6-mini", true],
    ["openai/gpt-6-astra", true],
    ["gpt-60", false],
    ["gpt-65", false],
    ["gpt-5.6", false],
    ["gpt-5", false],
    ["claude-opus-4-5", false],
    ["", false],
  ])("%s → %s", (modelId, eligible) => {
    expect(SessionEffort.isConfigurationUpdateEligible(modelId)).toBe(eligible)
  })
})

describe("session.effort base freeze (WS4a)", () => {
  test("baseReasoningEffort freezes at first request and never moves", () => {
    const sid = "ses-freeze"
    expect(SessionEffort.baseReasoningEffort(sid)).toBeUndefined()

    SessionEffort.freezeBaseReasoningEffort(sid, "medium")
    // First request wins — a later freeze (or applyEffortChange) never moves it.
    SessionEffort.freezeBaseReasoningEffort(sid, "high")
    expect(SessionEffort.baseReasoningEffort(sid)).toBe("medium")
    expect(SessionEffort.effectiveReasoningEffort(sid)).toBe("medium")

    // No effort known yet (e.g. a model without effort options) records nothing.
    SessionEffort.freezeBaseReasoningEffort("ses-freeze-empty", undefined)
    expect(SessionEffort.baseReasoningEffort("ses-freeze-empty")).toBeUndefined()
  })
})

describe("session.message-v2 configuration_update round-trip (WS4a)", () => {
  test("lowers configuration_update at its original position and preserves assistant phase metadata", async () => {
    const input: SessionV1.WithParts[] = [
      userText("m-u1", "hello"),
      {
        info: assistantInfo("m-a1", "m-u1"),
        parts: [
          {
            ...basePart("m-a1", "p1"),
            type: "text",
            text: "hi",
            metadata: { openai: { phase: "final_answer" } },
          },
        ] as SessionV1.Part[],
      },
      marker("m-u2", "high"),
      userText("m-u3", "next"),
    ]

    // The marker lowers to its own user-turn carrier between the assistant
    // reply and the next real turn — the position OpenAI expects the
    // configuration_update input item at. Assistant part metadata (where a
    // response `phase` rides) passes through untouched.
    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi", providerOptions: { openai: { phase: "final_answer" } } }],
      },
      loweredMarker("high"),
      { role: "user", content: [{ type: "text", text: "next" }] },
    ])
  })

  test("coalesces adjacent configuration_update markers at lowering (API 400 guard)", async () => {
    const input: SessionV1.WithParts[] = [userText("m-u1", "hello"), marker("m-u2", "high"), marker("m-u3", "xhigh"), userText("m-u4", "next")]

    // Two adjacent markers can never have been sent successfully; lowering
    // collapses them to the single effective update at the first position.
    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      loweredMarker("xhigh"),
      { role: "user", content: [{ type: "text", text: "next" }] },
    ])
  })
})

describe("session.effort applyEffortChange (WS4a)", () => {
  it.instance("appends one marker, coalesces repeats, keeps base frozen", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      const sid = created.id
      const addUser = Effect.fn("Test.addUser")(function* (text: string) {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID: sid,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-6-astra") },
        } satisfies SessionV1.User)
        yield* session.updatePart({ id: PartID.ascending(), sessionID: sid, messageID: id, type: "text", text })
        return id
      })

      yield* addUser("hello")
      SessionEffort.freezeBaseReasoningEffort(sid, "medium")

      const first = yield* SessionEffort.applyEffortChange(sid, "high")
      expect(first?.type).toBe("configuration_update")
      expect(first?.reasoning.effort).toBe("high")

      // Second change before any user turn coalesces into the SAME marker —
      // never two adjacent configuration_update items (API 400).
      const second = yield* SessionEffort.applyEffortChange(sid, "xhigh")
      expect(second?.reasoning.effort).toBe("xhigh")

      // Repeating the effort already in effect writes nothing.
      expect(yield* SessionEffort.applyEffortChange(sid, "xhigh")).toBeUndefined()

      // Base frozen at the first request; only the effective effort moved.
      expect(SessionEffort.baseReasoningEffort(sid)).toBe("medium")
      expect(SessionEffort.effectiveReasoningEffort(sid)).toBe("xhigh")

      const afterCoalesce = yield* session.messages({ sessionID: sid })
      expect(afterCoalesce).toHaveLength(2)
      expect(afterCoalesce[1]?.parts).toMatchObject([
        { type: "configuration_update", reasoning: { effort: "xhigh" } },
      ])

      // A real turn between changes allows a second, non-adjacent marker.
      yield* addUser("next")
      const third = yield* SessionEffort.applyEffortChange(sid, "low")
      expect(third?.reasoning.effort).toBe("low")
      expect(SessionEffort.baseReasoningEffort(sid)).toBe("medium")

      const messages = yield* session.messages({ sessionID: sid })
      expect(messages).toHaveLength(4)
      const markers = messages.filter((msg) => msg.parts.some((part) => part.type === "configuration_update"))
      expect(markers).toHaveLength(2)

      // Stateless replay: both markers round-trip through the store at their
      // original positions, separated by the real turn (never adjacent).
      const replay = yield* Effect.promise(() => MessageV2.toModelMessages(messages, model))
      expect(replay).toStrictEqual([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        loweredMarker("xhigh"),
        { role: "user", content: [{ type: "text", text: "next" }] },
        loweredMarker("low"),
      ])
    }),
  )
})

describe("session.llm prepare effort pin (WS4a)", () => {
  it.instance("pinned prepared options effort equals base, not effective", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      const sid = created.id

      // Eligible model with effort variants that merge as { reasoningEffort }.
      const gpt6: Provider.Model = {
        ...model,
        id: ModelV2.ID.make("gpt-6-astra"),
        api: { id: "gpt-6-astra", url: "https://example.com", npm: "@ai-sdk/openai" },
        variants: { medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } },
      }

      const prepare = (variant: "medium" | "high") =>
        LLMRequestPrep.prepare({
          user: {
            id: MessageID.ascending(),
            sessionID: sid,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: {
              providerID: ProviderV2.ID.make("openai"),
              modelID: ModelV2.ID.make("gpt-6-astra"),
              variant,
            },
          } as unknown as SessionV1.User,
          sessionID: sid,
          model: gpt6,
          agent: {
            name: "test",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info,
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          system: [],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
          provider: {
            id: ProviderV2.ID.make("openai"),
            name: "OpenAI",
            source: "api",
            env: [],
            options: {},
            models: {},
          },
          auth: undefined,
          plugin,
          flags,
          isWorkflow: false,
        })

      // Seed a real user turn so applyEffortChange can reuse its agent/model.
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID: sid,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-6-astra") },
      } satisfies SessionV1.User)
      yield* session.updatePart({ id: PartID.ascending(), sessionID: sid, messageID, type: "text", text: "hello" })

      // First eligible request: base freezes at the variant's request-level effort.
      const first = yield* prepare("medium")
      expect(first.messageTransformOptions.reasoningEffort).toBe("medium")
      expect(SessionEffort.baseReasoningEffort(sid)).toBe("medium")

      // Mid-conversation change: the marker moves only the effective effort.
      const markerPart = yield* SessionEffort.applyEffortChange(sid, "high")
      expect(markerPart?.type).toBe("configuration_update")
      expect(SessionEffort.baseReasoningEffort(sid)).toBe("medium")
      expect(SessionEffort.effectiveReasoningEffort(sid)).toBe("high")

      // The next request still carries the legacy variant rewrite ("high"),
      // but the pin forces the frozen base back onto the prepared options —
      // top-level effort stays byte-stable; "high" rides the marker instead.
      const second = yield* prepare("high")
      expect(second.messageTransformOptions.reasoningEffort).toBe("medium")
      expect(second.params.options.reasoningEffort).toBe("medium")
      expect(SessionEffort.baseReasoningEffort(sid)).toBe("medium")
      expect(SessionEffort.effectiveReasoningEffort(sid)).toBe("high")
    }),
  )
})
