/**
 * Explicit `jev_judge` tool integration tests.
 *
 * Covers the four contract seams of src/tool/jev-judge.ts:
 *   1. bounded state/question/choices (+ wire JSON Schema + privacy warning);
 *   2. fail-safe responses for disabled config and missing key — no request,
 *      no activity, and an explicit "UNANSWERED" escalation back to the model;
 *   3. no request unless a visible durable activity started (activity target
 *      validation gates Jev.decide);
 *   4. the happy path: exactly ONE fake-fetch call (no double usage), one
 *      running → completed activity keyed by ctx.callID under the assistant
 *      message, plus the registry/permission wiring (registry registration,
 *      explore allow row after its `* deny`).
 *
 * Network: Jev.decide falls back to the global fetch, so the tests stub
 * `globalThis.fetch` — the disabled/no-key/activity-guard tests install the
 * stub as a tripwire and assert zero calls.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { JevJudgeTool, Parameters } from "@/tool/jev-judge"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    FSUtil.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
  ),
)

// Registry runtime mirrors test/tool/skill.test.ts: ToolRegistry.defaultLayer
// self-provides Agent/Session/Config/Truncate; Ripgrep (grep tool init) comes
// from outside.
const registryIt = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

// --- env + fetch control -----------------------------------------------------

const JEV_ENV_KEYS = ["BANYANCODE_JEV_API_KEY", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"] as const
const savedEnv: Record<string, string | undefined> = Object.fromEntries(
  JEV_ENV_KEYS.map((key) => [key, process.env[key]]),
)
const realFetch = globalThis.fetch

type JevRequestBody = {
  state: string
  model: string
  questions: Record<string, { type: string; instructions: string; criteria: Record<string, string | null> }>
}
type FakeCall = { url: string; body: JevRequestBody }
let fetchCalls: FakeCall[] = []

const setJevEnv = (values: Record<string, string | undefined>): void => {
  for (const key of JEV_ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
}

const installFakeJev = (answer: {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}): void => {
  fetchCalls = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) as JevRequestBody })
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: { decision: { type: "choice", ...answer } },
        usage: { input_tokens: 120, output_tokens: 4, cost: 0.002 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }, { preconnect: realFetch.preconnect })
}

afterEach(() => {
  setJevEnv(savedEnv)
  globalThis.fetch = realFetch
  fetchCalls = []
  recordedAsks.length = 0
})

// --- config service double ---------------------------------------------------

const configService = (cfg: Banyan.BanyanConfigInfo) =>
  Banyan.BanyanConfigService.of({
    get: () => Effect.succeed(cfg),
    getGlobal: () => Effect.succeed(cfg),
    update: (patch) => Effect.succeed({ ...cfg, ...patch }),
    updateAgentOverride: () => Effect.succeed(cfg),
    getAgentOverrides: () => Effect.succeed(cfg.agent),
    updateAgentPrompt: () => Effect.succeed(cfg),
  })

// --- tool context helpers ----------------------------------------------------

type AskRequest = Parameters<Tool.Context["ask"]>[0]
const recordedAsks: AskRequest[] = []

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_jev"),
  messageID: MessageID.make("msg_jev"),
  callID: "call_jev_1",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const judgeCtx = (overrides: Partial<Omit<Tool.Context, "ask">> = {}): Tool.Context => ({
  ...baseCtx,
  ask: (req) =>
    Effect.sync(() => {
      recordedAsks.push(req)
    }),
  ...overrides,
})

const executeJudge = (
  judge: Pick<Tool.InferDef<typeof JevJudgeTool>, "execute">,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
  cfg: Banyan.BanyanConfigInfo,
) => judge.execute(params, ctx).pipe(Effect.provideService(Banyan.BanyanConfigService, configService(cfg)))

const validParams = {
  state: "route the subagent",
  question: "Which model should run this task?",
  choices: ["default", "alternate"],
}

const seedMessages = (withAssistant: boolean) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const created = yield* sessions.create({})
    const userID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: userID,
      sessionID: created.id,
      role: "user",
      time: { created: Date.now() },
      agent: "test",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    } satisfies SessionV1.User)
    const assistantID = withAssistant ? MessageID.ascending() : undefined
    if (assistantID) {
      yield* sessions.updateMessage({
        id: assistantID,
        sessionID: created.id,
        role: "assistant",
        time: { created: Date.now() },
        parentID: userID,
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "build",
        agent: "test",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } satisfies SessionV1.Assistant)
    }
    return { sessionID: created.id, userID, assistantID }
  })

describe("tool.jev_judge parameters", () => {
  const decode = (input: unknown) => Result.isSuccess(Schema.decodeUnknownResult(Parameters)(input))

  test("id is jev_judge", () => expect(JevJudgeTool.id).toBe("jev_judge"))

  test("bounds state, question, and choices", () => {
    expect(decode({ state: "facts", question: "which one?", choices: ["a", "b"] })).toBe(true)
    expect(decode({ state: "", question: "q", choices: ["a", "b"] })).toBe(false)
    expect(decode({ state: "s".repeat(8001), question: "q", choices: ["a", "b"] })).toBe(false)
    expect(decode({ state: "s", question: "q".repeat(1001), choices: ["a", "b"] })).toBe(false)
    expect(decode({ state: "s", question: "q", choices: ["a"] })).toBe(false)
    expect(decode({ state: "s", question: "q", choices: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })).toBe(false)
    expect(decode({ state: "s", question: "q", choices: ["a", "x".repeat(121)] })).toBe(false)
    expect(decode({})).toBe(false)
  })

  test("projects bounded JSON Schema for the wire", () => {
    const doc = ToolJsonSchema.fromSchema(Parameters)
    expect(doc.type).toBe("object")
    expect(doc.required).toEqual(["state", "question", "choices"])
    const props = JSON.stringify(doc.properties ?? {})
    expect(props).toContain('"maxLength":8000')
    expect(props).toContain('"maxLength":1000')
    expect(props).toContain('"maxLength":120')
    expect(props).toContain('"minItems":2')
    expect(props).toContain('"maxItems":8')
  })
})

describe("tool.jev_judge execution", () => {
  it.instance(
    "description carries the privacy warning and fail-safe contract",
    () =>
      Effect.gen(function* () {
        const info = yield* JevJudgeTool
        const judge = yield* info.init()
        expect(judge.description).toContain("PRIVACY WARNING")
        expect(judge.description).toContain("never include secrets")
        expect(judge.description).toContain("UNANSWERED")
        expect(judge.description).toContain("exactly one Jev request")
      }),
    15_000,
  )

  it.instance(
    "disabled config fails safe with no request and no activity",
    () =>
      Effect.gen(function* () {
        setJevEnv({ BANYANCODE_JEV_API_KEY: "test-key" })
        installFakeJev({ choice: "alternate", confidence: 0.9, probabilities: { default: 0.1, alternate: 0.9 } })
        const info = yield* JevJudgeTool
        const judge = yield* info.init()
        const result = yield* executeJudge(judge, validParams, judgeCtx(), { banyancode_jev_enabled: false })
        expect(result.output).toContain('status="unavailable"')
        expect(result.output).toContain("banyancode_jev_enabled=false")
        expect(result.output).toContain("UNANSWERED")
        expect(result.metadata.status).toBe("unavailable")
        expect(fetchCalls).toHaveLength(0)
        expect(recordedAsks).toHaveLength(1)
        expect(recordedAsks[0].permission).toBe("jev_judge")
      }),
    15_000,
  )

  it.instance(
    "missing key fails safe with no request",
    () =>
      Effect.gen(function* () {
        setJevEnv({})
        installFakeJev({ choice: "alternate", confidence: 0.9, probabilities: { default: 0.1, alternate: 0.9 } })
        const info = yield* JevJudgeTool
        const judge = yield* info.init()
        const result = yield* executeJudge(judge, validParams, judgeCtx(), {})
        expect(result.output).toContain('status="unavailable"')
        expect(result.output).toContain("no Jev API key")
        expect(result.output).toContain("UNANSWERED")
        expect(fetchCalls).toHaveLength(0)
        expect(recordedAsks).toHaveLength(1)
        expect(recordedAsks[0].permission).toBe("jev_judge")
      }),
    15_000,
  )

  it.instance(
    "sends no request when no visible activity can start for the message",
    () =>
      Effect.gen(function* () {
        setJevEnv({ BANYANCODE_JEV_API_KEY: "test-key" })
        installFakeJev({ choice: "alternate", confidence: 0.9, probabilities: { default: 0.1, alternate: 0.9 } })
        const seeded = yield* seedMessages(false)
        const info = yield* JevJudgeTool
        const judge = yield* info.init()
        // Target is a USER message: JevActivity.start rejects it (typed error),
        // so the guard must skip Jev.decide entirely.
        const result = yield* executeJudge(
          judge,
          validParams,
          judgeCtx({ sessionID: seeded.sessionID, messageID: seeded.userID }),
          {},
        )
        expect(result.output).toContain('status="unavailable"')
        expect(result.output).toContain("no visible Jev activity")
        expect(result.output).toContain("UNANSWERED")
        expect(fetchCalls).toHaveLength(0)
        const sessions = yield* Session.Service
        const messages = yield* sessions.messages({ sessionID: seeded.sessionID })
        const jevParts = messages.flatMap((m) =>
          m.parts.filter((part): part is SessionV1.JevActivityPart => part.type === "jev_activity"),
        )
        expect(jevParts).toHaveLength(0)
      }),
    15_000,
  )

  it.instance(
    "judges exactly once and finishes the visible activity keyed by ctx.callID",
    () =>
      Effect.gen(function* () {
        setJevEnv({ BANYANCODE_JEV_API_KEY: "test-key" })
        installFakeJev({ choice: "alternate", confidence: 0.91, probabilities: { default: 0.09, alternate: 0.91 } })
        const seeded = yield* seedMessages(true)
        if (!seeded.assistantID) throw new Error("assistant message missing")
        const info = yield* JevJudgeTool
        const judge = yield* info.init()
        const result = yield* executeJudge(
          judge,
          validParams,
          judgeCtx({ sessionID: seeded.sessionID, messageID: seeded.assistantID, callID: "call_jev_1" }),
          {},
        )

        // The verdict reaches the model.
        expect(JSON.parse(result.output)).toMatchObject({ status: "ok", choice: "alternate" })
        expect(result.metadata).toMatchObject({ status: "ok", choice: "alternate", confidence: 0.91 })

        // Exactly one request — no double usage — carrying the bounded inputs.
        expect(fetchCalls).toHaveLength(1)
        expect(fetchCalls[0].url).toBe("https://api.typesafe.ai/v1/systemone")
        expect(fetchCalls[0].body.state).toBe(validParams.state)
        expect(fetchCalls[0].body.questions.decision.instructions).toBe(validParams.question)
        expect(fetchCalls[0].body.questions.decision.type).toBe("choice")

        // Permission ask fired once with the tool's own permission id.
        expect(recordedAsks).toHaveLength(1)
        expect(recordedAsks[0].permission).toBe("jev_judge")

        // ONE durable activity under the current assistant message: running →
        // completed in place, stable operation id from ctx.callID.
        const sessions = yield* Session.Service
        const messages = yield* sessions.messages({ sessionID: seeded.sessionID })
        const jevParts = messages.flatMap((m) =>
          m.parts.filter((part): part is SessionV1.JevActivityPart => part.type === "jev_activity"),
        )
        expect(jevParts).toHaveLength(1)
        expect(jevParts[0]).toMatchObject({
          status: "completed",
          operationID: "call_jev_1",
          feature: "jev-judge",
          choice: "alternate",
          messageID: seeded.assistantID,
          usage: { input: 120, output: 4, cost: 0.002 },
        })
        expect(jevParts[0].latency?.ms).toBeGreaterThanOrEqual(0)
      }),
    15_000,
  )

  it.instance(
    "explore explicitly allows jev_judge after its wildcard deny",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const explore = yield* agents.get("explore")
        expect(explore).toBeDefined()
        if (!explore) throw new Error("explore agent not found")
        // Without this allow row Permission.disabled strips jev_judge from
        // explore's wire tool list (session/llm/request.ts resolveTools).
        expect(Permission.evaluate("jev_judge", "*", explore.permission).action).toBe("allow")
        const build = yield* agents.get("build")
        expect(build).toBeDefined()
        if (!build) throw new Error("build agent not found")
        expect(Permission.evaluate("jev_judge", "*", build.permission).action).toBe("allow")
      }),
    15_000,
  )
})

describe("tool registry", () => {
  registryIt.instance(
    "registers jev_judge and exposes it to the LLM with its description",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).toContain("jev_judge")

        const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
        const tools = yield* registry.tools({
          providerID: ProviderV2.ID.opencode,
          modelID: ModelV2.ID.make("test"),
          agent,
        })
        const tool = tools.find((entry) => entry.id === "jev_judge")
        expect(tool).toBeDefined()
        if (!tool) return
        expect(tool.description).toContain("PRIVACY WARNING")
        expect(tool.parameters).toBeDefined()
      }),
    30_000,
  )
})
