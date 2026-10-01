import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID } from "@/session/schema"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Database } from "@opencode-ai/core/database/database"
import { Banyan } from "@opencode-ai/core/banyancode"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const config = {
  banyancode_jev_enabled: true,
  banyancode_jev_subagent_models: { explore: { model: "cheap/mini", thinking: "low" } },
} as const

const model: Provider.Model = {
  id: ModelV2.ID.make("mini"),
  providerID: ProviderV2.ID.make("cheap"),
  api: { id: "mini", url: "https://example.com", npm: "@ai-sdk/openai" },
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

const banyanLayer = Layer.succeed(
  Banyan.BanyanConfigService,
  Banyan.BanyanConfigService.of({
    get: () => Effect.succeed(config),
    getGlobal: () => Effect.succeed(config),
    update: () => Effect.succeed(config),
    updateAgentOverride: () => Effect.succeed(config),
    getAgentOverrides: () => Effect.succeed(undefined),
    updateAgentPrompt: () => Effect.succeed(config),
  }),
)

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer({}),
    banyanLayer,
    Layer.mock(Provider.Service, {
      getModel: () => Effect.succeed(model),
    }),
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

const savedKey = process.env.BANYANCODE_JEV_API_KEY
const savedFetch = globalThis.fetch
afterEach(async () => {
  if (savedKey === undefined) delete process.env.BANYANCODE_JEV_API_KEY
  else process.env.BANYANCODE_JEV_API_KEY = savedKey
  globalThis.fetch = savedFetch
  await disposeAllInstances()
})

const promptOps = (selected: string[]): TaskPromptOps => ({
  cancel: () => Effect.void,
  resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
  prompt: (input) =>
    Effect.sync(() => {
      selected.push(`${input.model?.providerID}/${input.model?.modelID}`)
      const id = MessageID.ascending()
      return {
        info: {
          id,
          role: "assistant" as const,
          sessionID: input.sessionID,
          parentID: input.messageID ?? MessageID.ascending(),
          modelID: input.model?.modelID ?? ModelV2.ID.make("base"),
          providerID: input.model?.providerID ?? ProviderV2.ID.make("original"),
          mode: "explore",
          agent: "explore",
          cost: 0,
          path: { cwd: "/", root: "/" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        },
        parts: [{ id: SessionV1.PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text" as const, text: "done" }],
      }
    }),
})

describe("Jev TaskTool routing", () => {
  it.instance("selects a configured alternate and records one visible decision", () =>
    Effect.gen(function* () {
      process.env.BANYANCODE_JEV_API_KEY = "test-jev-key"
      let calls = 0
      let confidence = 0.9
      let probabilities = { default: 0.05, alternate: 0.95 }
      globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: { decision: { type: "choice", choice: "alternate", confidence, probabilities } },
        usage: { input_tokens: 200, output_tokens: 12 },
      }), { status: 200 }), { preconnect: savedFetch.preconnect })
      const fetcher = globalThis.fetch
      globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetcher>) => {
        calls++
        return fetcher(...args)
      }, { preconnect: savedFetch.preconnect })

      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "user", time: { created: Date.now() },
        agent: "build", model: { providerID: ProviderV2.ID.make("original"), modelID: ModelV2.ID.make("base") },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "assistant", time: { created: Date.now() },
        parentID: user.id, modelID: ModelV2.ID.make("base"), providerID: ProviderV2.ID.make("original"),
        mode: "build", agent: "build", cost: 0, path: { cwd: "/", root: "/" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const selected: string[] = []
      const run = (callID: string) => def.execute(
        { description: "Find cache implementation", prompt: "Find the cache entrypoints", subagent_type: "explore" },
        {
          sessionID: parent.id, messageID: assistant.id, callID, agent: "build",
          abort: new AbortController().signal, messages: [], extra: { promptOps: promptOps(selected) },
          metadata: () => Effect.void, ask: () => Effect.void,
        },
      )
      yield* run("call_jev_route")
      const parts = (yield* sessions.messages({ sessionID: parent.id })).flatMap((message) => message.parts)
      expect(selected).toEqual(["cheap/mini"])
      expect(parts.filter((part) => part.type === "jev_activity")).toMatchObject([
        { operationID: "task:call_jev_route", status: "completed", choice: "alternate", messageID: assistant.id },
      ])
      expect(calls).toBe(1)

      confidence = 0.6
      probabilities = { default: 0.45, alternate: 0.55 }
      // Distinct task text: the client caches by (state, questions, session),
      // so an identical prompt would reuse the first answer with zero usage.
      const unsureRun = (callID: string) => def.execute(
        { description: "Fix parser edge case", prompt: "Fix the parser edge cases in the new module", subagent_type: "explore" },
        {
          sessionID: parent.id, messageID: assistant.id, callID, agent: "build",
          abort: new AbortController().signal, messages: [], extra: { promptOps: promptOps(selected) },
          metadata: () => Effect.void, ask: () => Effect.void,
        },
      )
      yield* unsureRun("call_jev_route_unsure")
      expect(selected).toEqual(["cheap/mini", "original/base"])
      expect(calls).toBe(2)
      const unsure = (yield* sessions.messages({ sessionID: parent.id })).flatMap((message) => message.parts)
        .find((part) => part.type === "jev_activity" && part.operationID === "task:call_jev_route_unsure")
      expect(unsure).toMatchObject({ status: "completed", choice: "default" })

      delete process.env.BANYANCODE_JEV_API_KEY
      yield* run("call_jev_route_no_key")
      expect(selected).toEqual(["cheap/mini", "original/base", "original/base"])
      expect(calls).toBe(2)
    }),
    30_000,
  )

  it.instance("attributes usage once per physical request and never double-counts", () =>
    Effect.gen(function* () {
      process.env.BANYANCODE_JEV_API_KEY = "test-jev-key"
      let calls = 0
      globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: { decision: { type: "choice", choice: "alternate", confidence: 0.9, probabilities: { default: 0.05, alternate: 0.95 } } },
        usage: { input_tokens: 200, output_tokens: 12 },
      }), { status: 200 }), { preconnect: savedFetch.preconnect })
      const fetcher = globalThis.fetch
      globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetcher>) => {
        calls++
        return fetcher(...args)
      }, { preconnect: savedFetch.preconnect })

      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "usage-parent" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "user", time: { created: Date.now() },
        agent: "build", model: { providerID: ProviderV2.ID.make("original"), modelID: ModelV2.ID.make("base") },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "assistant", time: { created: Date.now() },
        parentID: user.id, modelID: ModelV2.ID.make("base"), providerID: ProviderV2.ID.make("original"),
        mode: "build", agent: "build", cost: 0, path: { cwd: "/", root: "/" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const selected: string[] = []
      const info = yield* def.execute(
        { description: "Find cache implementation", prompt: "Find the cache entrypoints", subagent_type: "explore" },
        {
          sessionID: parent.id, messageID: assistant.id, callID: "call_jev_usage", agent: "build",
          abort: new AbortController().signal, messages: [], extra: { promptOps: promptOps(selected) },
          metadata: () => Effect.void, ask: () => Effect.void,
        },
      )
      expect(info.metadata.model).toEqual({ providerID: "cheap", modelID: "mini" })
      expect(calls).toBe(1)
      const rows = (yield* sessions.messages({ sessionID: parent.id })).flatMap((message) => message.parts)
        .filter((part) => part.type === "jev_activity" && part.operationID === "task:call_jev_usage")
      expect(rows).toHaveLength(1)
      // Single attribution on the visible row; the assistant message that owns
      // the activity keeps its own cost/tokens (no double-count into session).
      expect(rows[0]).toMatchObject({ status: "completed", choice: "alternate", usage: { input: 200, output: 12 } })
      expect(rows[0]).toMatchObject({ messageID: assistant.id })
    }),
    30_000,
  )

  it.instance("resumed tasks keep their model with no new request", () =>
    Effect.gen(function* () {
      process.env.BANYANCODE_JEV_API_KEY = "test-jev-key"
      let calls = 0
      globalThis.fetch = Object.assign(async (..._args: unknown[]) => {
        calls++
        return new Response(JSON.stringify({
          model: "jev-1.13.0",
          answers: { decision: { type: "choice", choice: "alternate", confidence: 0.9, probabilities: { default: 0.05, alternate: 0.95 } } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }), { status: 200 })
      }, { preconnect: savedFetch.preconnect })

      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "resume-parent" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "user", time: { created: Date.now() },
        agent: "build", model: { providerID: ProviderV2.ID.make("original"), modelID: ModelV2.ID.make("base") },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "assistant", time: { created: Date.now() },
        parentID: user.id, modelID: ModelV2.ID.make("base"), providerID: ProviderV2.ID.make("original"),
        mode: "build", agent: "build", cost: 0, path: { cwd: "/", root: "/" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const selected: string[] = []
      const ctxFor = (messageID: typeof assistant.id, callID: string) => ({
        sessionID: parent.id, messageID, callID, agent: "build" as const,
        abort: new AbortController().signal, messages: [] as SessionV1.WithParts[],
        extra: { promptOps: promptOps(selected) },
        metadata: () => Effect.void, ask: () => Effect.void,
      })
      // Fresh spawn routes once; resuming via task_id is pinned to the
      // existing child session and never reroutes (no new request).
      const first = yield* def.execute(
        { description: "Find cache implementation", prompt: "Find the cache entrypoints", subagent_type: "explore" },
        ctxFor(assistant.id, "call_resume_1"),
      )
      const childID = (first.metadata as { sessionId: string }).sessionId
      const before = calls
      expect(before).toBe(1)
      yield* def.execute(
        { description: "Follow up", prompt: "More context", subagent_type: "explore", task_id: childID },
        ctxFor(assistant.id, "call_resume_2"),
      )
      expect(calls).toBe(before)
      // NOTE: a non-assistant ctx.messageID is a programming error in this
      // route (prompt.ts always passes the persisted assistant message), so
      // it fails loudly instead of spending a request. Message targeting is
      // covered by the activity row assertions above (messageID) and by the
      // fail-safe no-request tests in jev-judge/jev-turn.
    }),
    30_000,
  )

  it.instance("cancelled routing settles skipped/default with no model change", () =>
    Effect.gen(function* () {
      process.env.BANYANCODE_JEV_API_KEY = "test-jev-key"
      let calls = 0
      globalThis.fetch = Object.assign(async (..._args: unknown[]) => {
        calls++
        return new Response(JSON.stringify({
          model: "jev-1.13.0",
          answers: { decision: { type: "choice", choice: "alternate", confidence: 0.9, probabilities: { default: 0.05, alternate: 0.95 } } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }), { status: 200 })
      }, { preconnect: savedFetch.preconnect })

      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "cancel-parent" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "user", time: { created: Date.now() },
        agent: "build", model: { providerID: ProviderV2.ID.make("original"), modelID: ModelV2.ID.make("base") },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(), sessionID: parent.id, role: "assistant", time: { created: Date.now() },
        parentID: user.id, modelID: ModelV2.ID.make("base"), providerID: ProviderV2.ID.make("original"),
        mode: "build", agent: "build", cost: 0, path: { cwd: "/", root: "/" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const selected: string[] = []
      const aborted = new AbortController()
      aborted.abort()
      yield* def.execute(
        { description: "Find cache implementation", prompt: "Find the cache entrypoints", subagent_type: "explore" },
        {
          sessionID: parent.id, messageID: assistant.id, callID: "call_cancelled", agent: "build",
          abort: aborted.signal, messages: [], extra: { promptOps: promptOps(selected) },
          metadata: () => Effect.void, ask: () => Effect.void,
        },
      )
      expect(selected).toEqual(["original/base"])
      const row = (yield* sessions.messages({ sessionID: parent.id })).flatMap((message) => message.parts)
        .find((part) => part.type === "jev_activity" && part.operationID === "task:call_cancelled")
      expect(row).toMatchObject({ messageID: assistant.id })
      expect(calls).toBe(0)
    }),
    30_000,
  )
})
