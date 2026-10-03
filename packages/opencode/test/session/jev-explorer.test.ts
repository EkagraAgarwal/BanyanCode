import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { Jev } from "@opencode-ai/core/banyancode/jev"
import type { Info as BanyanConfigInfo } from "@opencode-ai/core/v1/config/banyan-config"
import { Effect, Layer } from "effect"
import path from "path"
import type { ModelMessage } from "ai"
import { MessageV2 } from "@/session/message-v2"
import { Session as SessionNs } from "@/session/session"
import { JevExplorer } from "@/session/jev-explorer"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// Jev-explorer engine integration: real Session.updatePart publishing, a real
// tmpdir workspace for stop verification, and a MOCK fetch injected into
// Jev.decide — NO paid/real Jev request is ever made (endpoint override +
// injected fetch), and no other network call is possible (tool dispatch and
// staleness are scripted seams).
const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Database.defaultLayer))

const JEV_ENDPOINT = "https://jev.test/v1/systemone"
const TREE_CONFIG = { banyancode_jev_tree: { enabled: true } } satisfies BanyanConfigInfo
const KEY_ENV = { BANYANCODE_JEV_API_KEY: "test-key" }

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
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

const DEMO_REL = "packages/core/src/demo.ts"
const DEMO_LINES = 30
const DEMO_TEXT = Array.from({ length: DEMO_LINES }, (_, index) => `export const line${index + 1} = ${index + 1}`).join("\n")

interface ScriptedAnswer {
  readonly choice: string
  readonly confidence?: number
  /** Optional top-probability override (default derives from confidence); lets tests craft narrow margins. */
  readonly chosen?: number
}

/** Canned-choice fetch: parses the request's criteria keys and answers over exactly those choices. */
const jevFetch = (script: ScriptedAnswer[]) => {
  let index = 0
  const state = { calls: 0, urls: [] as string[] }
  const fetcher: Jev.Fetch = async (url, init) => {
    state.calls++
    state.urls.push(url)
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { criteria: Record<string, unknown> }>
    }
    const questionID = Object.keys(body.questions)[0]
    const choices = Object.keys(body.questions[questionID].criteria)
    const scripted = script[Math.min(index, script.length - 1)]
    index++
    const choice = choices.includes(scripted.choice) ? scripted.choice : choices[0]
    const confidence = scripted.confidence ?? 0.95
    const chosenProbability = scripted.chosen ?? Math.min(Math.max(confidence, 0.5), 0.99)
    const rest = choices.filter((item) => item !== choice)
    const others = (1 - chosenProbability) / Math.max(rest.length, 1)
    const probabilities = Object.fromEntries(choices.map((item) => [item, item === choice ? chosenProbability : others]))
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers: { [questionID]: { type: "choice", choice, confidence, probabilities } },
        usage: { input_tokens: 11, output_tokens: 3, cost: 0.002 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }
  return { fetch: fetcher, state }
}

const healthyStaleness: JevExplorer.ToolOutcome = {
  ok: true,
  json: { staleFiles: 0, missingFiles: 0, totalFiles: 100 },
  value: "staleFiles=0 missingFiles=0 totalFiles=100",
  bytes: 40,
}

const DEMO_QUERY_HIT = `Symbol slice found: ${DEMO_REL}:10-12 — demo declaration, plus ${DEMO_REL} listed in files.`

interface Turn {
  readonly sessionID: SessionID
  readonly userID: MessageID
  readonly assistantID: MessageID
}

const makeTurn = Effect.gen(function* () {
  const session = yield* SessionNs.Service
  const created = yield* session.create({})
  const sessionID = created.id
  const providerID = ProviderV2.ID.make("test")
  const userID = MessageID.ascending()
  yield* session.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "explore",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "explore",
  } as unknown as SessionV1.User)
  const assistantID = MessageID.ascending()
  yield* session.updateMessage({
    id: assistantID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: userID,
    modelID: ModelV2.ID.make(model.api.id),
    providerID: model.providerID,
    mode: "explore",
    agent: "explore",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies SessionV1.Assistant)
  return { sessionID, userID, assistantID } satisfies Turn
})

const baseDeps = (overrides: Partial<JevExplorer.Deps> = {}): JevExplorer.Deps => ({
  ask: () => Effect.succeed(true),
  call: () => Effect.succeed({ ok: false, value: "unexpected call", bytes: 0 }),
  verifyFile: () => Effect.succeed(false),
  jev: { fetch: jevFetch([{ choice: "HANDOFF_TO_LLM" }]).fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
  ...overrides,
})

describe("jev-explorer eligibility", () => {
  const config = TREE_CONFIG as BanyanConfigInfo
  test("requires explorer agent + explicit tree enable + key + fresh non-json turn", () => {
    expect(JevExplorer.isEligible({ agentName: "explore", fresh: true, config, env: KEY_ENV })).toBe(true)
    expect(JevExplorer.isEligible({ agentName: "scout", fresh: true, config, env: KEY_ENV })).toBe(true)
    expect(JevExplorer.isEligible({ agentName: "researcher", fresh: true, config, env: KEY_ENV })).toBe(true)
    expect(JevExplorer.isEligible({ agentName: "coder", fresh: true, config, env: KEY_ENV })).toBe(false)
    expect(JevExplorer.isEligible({ agentName: "explore", fresh: false, config, env: KEY_ENV })).toBe(false)
    expect(JevExplorer.isEligible({ agentName: "explore", fresh: true, config: {}, env: KEY_ENV })).toBe(false)
    expect(JevExplorer.isEligible({ agentName: "explore", fresh: true, env: KEY_ENV })).toBe(false)
    expect(JevExplorer.isEligible({ agentName: "explore", fresh: true, config, env: {} })).toBe(false)
    expect(
      JevExplorer.isEligible({
        agentName: "explore",
        fresh: true,
        config,
        env: KEY_ENV,
        format: { type: "json_schema", schema: {} } as unknown as SessionV1.OutputFormat,
      }),
    ).toBe(false)
  })
})

// SSRF guard unit tests: every IPv4 bypass form blocks WITHOUT touching DNS
// (mocked resolver counts calls), hostnames resolve through a MOCKED resolver
// (zero real DNS), and every failure mode fails closed.
describe("jev-explorer webfetch SSRF guard", () => {
  const countingLookup = () => {
    const state = { calls: 0 }
    const lookup: JevExplorer.HostLookup = (hostname) => {
      state.calls++
      void hostname
      return Promise.resolve(["93.184.216.34"])
    }
    return { lookup, state }
  }

  test("normalizes integer, hex, and octal IPv4 forms and blocks private ranges without DNS", async () => {
    const { lookup, state } = countingLookup()
    const blocked = [
      "2130706433", // bare integer -> 127.0.0.1
      "0x7f000001", // bare hex -> 127.0.0.1
      "0x7f.0.0.1", // per-octet hex
      "0177.0.0.1", // per-octet octal
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254", // cloud metadata IP
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
    ]
    for (const host of blocked) expect(await JevExplorer.isBlockedHost(host, lookup)).toBe(true)
    expect(state.calls).toBe(0)
    expect(await JevExplorer.isBlockedHost("93.184.216.34", lookup)).toBe(false)
    expect(state.calls).toBe(0)
  })

  test("normalizes IPv4-mapped and private IPv6 literals without DNS", async () => {
    const { lookup, state } = countingLookup()
    const blocked = ["::1", "[::1]", "::", "fd00::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]
    for (const host of blocked) expect(await JevExplorer.isBlockedHost(host, lookup)).toBe(true)
    expect(state.calls).toBe(0)
  })

  test("blocks expanded IPv6 loopback, unspecified, and v4-mapped forms without DNS", async () => {
    const { lookup, state } = countingLookup()
    const blocked = [
      "0:0:0:0:0:0:0:1", // expanded loopback
      "0:0:0:0:0:0:0:0", // expanded unspecified
      "0:0:0:0:0:ffff:127.0.0.1", // expanded v4-mapped loopback
      "0:0:0:0:0:ffff:10.1.2.3", // expanded v4-mapped private
      "[0:0:0:0:0:ffff:192.168.1.1]", // bracketed expanded v4-mapped private
      "0:0:0:0:0:ffff:169.254.169.254", // expanded v4-mapped metadata IP
    ]
    for (const host of blocked) expect(await JevExplorer.isBlockedHost(host, lookup)).toBe(true)
    expect(state.calls).toBe(0)
    expect(await JevExplorer.isBlockedHost("0:0:0:0:0:ffff:93.184.216.34", lookup)).toBe(false)
    expect(await JevExplorer.isBlockedHost("2606:4700:4700::1111", lookup)).toBe(false)
    expect(state.calls).toBe(0)
  })

  test("blocks localhost variants without DNS", async () => {
    const { lookup, state } = countingLookup()
    for (const host of ["localhost", "app.localhost", "service.local", "db.internal", "router.home", ""]) {
      expect(await JevExplorer.isBlockedHost(host, lookup)).toBe(true)
    }
    expect(state.calls).toBe(0)
  })

  test("blocks a metadata-IP hostname via the mocked resolver when ANY resolved address is non-public", async () => {
    const metadata: JevExplorer.HostLookup = () => Promise.resolve(["169.254.169.254"])
    expect(await JevExplorer.isBlockedHost("metadata.attacker.example", metadata)).toBe(true)
    const mixed: JevExplorer.HostLookup = () => Promise.resolve(["93.184.216.34", "10.0.0.5"])
    expect(await JevExplorer.isBlockedHost("dual.attacker.example", mixed)).toBe(true)
    const publicOnly: JevExplorer.HostLookup = () => Promise.resolve(["93.184.216.34"])
    expect(await JevExplorer.isBlockedHost("example.com", publicOnly)).toBe(false)
  })

  test("fails closed on DNS failure, empty answers, and unparseable addresses", async () => {
    expect(await JevExplorer.isBlockedHost("down.attacker.example", () => Promise.reject(new Error("NXDOMAIN")))).toBe(
      true,
    )
    expect(await JevExplorer.isBlockedHost("none.attacker.example", () => Promise.resolve([]))).toBe(true)
    expect(await JevExplorer.isBlockedHost("weird.attacker.example", () => Promise.resolve(["not-an-ip"]))).toBe(true)
  })
})

describe("jev-explorer engine", () => {
  it.instance("starts a Jev activity before the request and writes a completed run part with evidence", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const testInstance = yield* TestInstance
      const turn = yield* makeTurn
      yield* Effect.promise(() =>
        Bun.write(path.join(testInstance.directory, DEMO_REL), DEMO_TEXT),
      )
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      let activityVisibleBeforeRequest = false
      const dispatched: string[] = []
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            dispatched.push(req.tool)
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: `unexpected ${req.tool}`, bytes: 0 }
          }),
        verifyFile: JevExplorer.verifyFileAt(testInstance.directory),
        decide: (input) =>
          Effect.promise(async () => {
            const messages = await Effect.runPromise(session.messages({ sessionID: turn.sessionID }))
            const parts = messages.find((item) => item.info.id === turn.assistantID)?.parts ?? []
            activityVisibleBeforeRequest = parts.some((part) => part.type === "jev_activity" && part.status === "running")
            return Jev.decide(input)
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_stop_1",
        agentName: "explore",
        task: "where is Session.updatePart defined?",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      // No-request-before-activity: the decide seam observed a durable running
      // activity row BEFORE Jev.decide touched the (mock) endpoint.
      expect(activityVisibleBeforeRequest).toBe(true)
      expect(script.state.calls).toBe(1)
      expect(script.state.urls).toEqual([JEV_ENDPOINT])
      expect(dispatched).toEqual(["codegraph_staleness", "repository_query"])
      expect(outcome.type).toBe("completed")
      if (outcome.type !== "completed") return
      expect(outcome.answer).toContain(DEMO_REL)
      expect(outcome.answer).toContain(":10-12")

      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const parts = rows.flatMap((item) => item.parts)
      const runParts = parts.filter((part) => part.type === "jev_run")
      expect(runParts).toHaveLength(1)
      expect(runParts[0]).toMatchObject({
        type: "jev_run",
        runID: "run_stop_1",
        status: "completed",
      })
      const run = runParts[0] as SessionV1.JevRunPart
      expect(run.nodes.length).toBeGreaterThanOrEqual(2)
      expect(run.nodes.at(-1)).toMatchObject({ actionID: "STOP_WITH_EVIDENCE", status: "done" })
      expect(run.nodes.at(-1)?.evidence?.[0]).toMatchObject({ path: DEMO_REL, lines: "10-12" })
      expect(run.usage).toMatchObject({ input: 11, output: 3, cost: 0.002 })
      const activityParts = parts.filter((part) => part.type === "jev_activity")
      expect(activityParts).toHaveLength(1)
      expect(activityParts[0]).toMatchObject({ status: "completed", feature: "jev-explorer" })
    }),
  )

  it.instance("dedup skips a repeated (action, target, graphVersion) without dispatching again", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const testInstance = yield* TestInstance
      const turn = yield* makeTurn
      yield* Effect.promise(() => Bun.write(path.join(testInstance.directory, DEMO_REL), DEMO_TEXT))
      const script = jevFetch([
        { choice: "REQUERY" },
        { choice: "REQUERY" },
        { choice: "STOP_WITH_EVIDENCE" },
      ])
      const dispatched: string[] = []
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            dispatched.push(req.tool)
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: `unexpected ${req.tool}`, bytes: 0 }
          }),
        verifyFile: JevExplorer.verifyFileAt(testInstance.directory),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_dedup_1",
        agentName: "explore",
        task: "find the demo declaration",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(script.state.calls).toBe(3)
      // node 0 query + ONE REQUERY dispatch; the repeat is skipped, not re-run.
      expect(dispatched.filter((tool) => tool === "repository_query")).toHaveLength(2)
      expect(outcome.type).toBe("completed")

      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows.flatMap((item) => item.parts).find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.status).toBe("completed")
      const skipped = run.nodes.filter((node) => node.actionID === "REQUERY" && node.status === "skipped")
      expect(skipped).toHaveLength(1)
      expect(skipped[0].target).toContain("find the demo declaration")
    }),
  )

  it.instance("hands off immediately on a stale graph without any Jev request", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const dispatched: string[] = []
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            dispatched.push(req.tool)
            if (req.tool === "codegraph_staleness")
              return {
                ok: true,
                json: { staleFiles: 50, missingFiles: 0, totalFiles: 100 },
                value: "staleFiles=50 missingFiles=0 totalFiles=100",
                bytes: 40,
              }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_stale_1",
        agentName: "explore",
        task: "anything",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(0)
      expect(dispatched).toEqual(["codegraph_staleness"])

      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const parts = rows.flatMap((item) => item.parts)
      expect(parts.filter((part) => part.type === "jev_activity")).toHaveLength(0)
      const run = parts.find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.status).toBe("handoff")
      expect(run.stopReason).toContain("graph-stale")
    }),
  )

  it.instance("hands off on an uncertain verdict (confidence below the floor)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "CODE_FIND", confidence: 0.5 }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_uncertain_1",
        agentName: "explore",
        task: "where is the demo?",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(1)

      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const parts = rows.flatMap((item) => item.parts)
      const run = parts.find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.status).toBe("handoff")
      expect(run.stopReason).toContain("low-confidence")
      // The request itself succeeded and settled its activity.
      const activity = parts.find((part) => part.type === "jev_activity")
      expect(activity).toMatchObject({ status: "completed", choice: "CODE_FIND" })
    }),
  )

  it.instance("hands off when stop verification cannot confirm a cited path", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const testInstance = yield* TestInstance
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const missingHit = `Symbol slice found: packages/core/src/missing.ts:5-9 — nothing on disk.`
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query") return { ok: true, value: missingHit, bytes: missingHit.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        verifyFile: JevExplorer.verifyFileAt(testInstance.directory),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_unverified_1",
        agentName: "explore",
        task: "find the missing declaration",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.status).toBe("handoff")
      expect(run.stopReason).toContain("unverified-path")
    }),
  )

  it.instance("settles the run part cancelled when the abort signal fires mid-run", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const controller = new AbortController()
      const script = jevFetch([{ choice: "REQUERY" }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        decide: (input) =>
          Effect.promise(async () => {
            const result = await Jev.decide(input)
            controller.abort()
            return result
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_cancel_1",
        agentName: "explore",
        task: "find the demo",
        config: TREE_CONFIG,
        env: KEY_ENV,
        abort: controller.signal,
        deps,
      })
      expect(outcome.type).toBe("cancelled")
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.status).toBe("cancelled")
      expect(run.stopReason).toBe("cancelled")
      // Cancelled with the activity settled, never left running forever.
      const activity = rows.flatMap((item) => item.parts).find((part) => part.type === "jev_activity")
      expect(activity).toBeDefined()
    }),
  )

  it.instance("json_schema turns are ineligible: no dispatch, no Jev request, no run part", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "REQUERY" }])
      const dispatched: string[] = []
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            dispatched.push(req.tool)
            return healthyStaleness
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_jsonschema_1",
        agentName: "explore",
        task: "structured exploration task",
        format: { type: "json_schema", schema: {} } as unknown as SessionV1.OutputFormat,
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("ineligible")
      expect(script.state.calls).toBe(0)
      expect(dispatched).toHaveLength(0)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      expect(rows.flatMap((item) => item.parts).filter((part) => part.type === "jev_run")).toHaveLength(0)
    }),
  )

  it.instance("caps payloads at exactly maxBytes before extraction and hands off", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const oversized = `Symbol slice found: ${DEMO_REL}:10-12 — ` + "y".repeat(5_000)
      // Materialized payload is hard-capped at EXACTLY the budget in UTF-8
      // bytes, never the old inflated floor (Math.max(maxBytes, 65_536) * 2).
      // (Char length is 1022 here: the em-dash in the prefix is 3 bytes.)
      expect(new TextEncoder().encode(JevExplorer.truncateToBytes(oversized, 1024)).byteLength).toBe(1024)

      // Multibyte text is capped in UTF-8 bytes (not UTF-16 units) without
      // splitting a sequence: "é" is 2 bytes, so 1024 bytes hold 512 chars.
      const multibyte = "é".repeat(1000)
      const cut = JevExplorer.truncateToBytes(multibyte, 1024)
      expect(new TextEncoder().encode(cut).byteLength).toBe(1024)
      expect(cut).not.toContain("�")
      expect(JevExplorer.truncateToBytes("short", 1024)).toBe("short")
      expect(JevExplorer.truncateToBytes("abc", 0)).toBe("")
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query") {
              const value = JevExplorer.truncateToBytes(oversized, req.maxBytes)
              expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(1024)
              return { ok: true, value, bytes: new TextEncoder().encode(value).byteLength }
            }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_cap_1",
        agentName: "explore",
        task: "find the demo",
        config: { banyancode_jev_tree: { enabled: true, maxBytes: 1024 } },
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(0)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.status).toBe("handoff")
      expect(run.stopReason).toBe("budget:max-bytes")
      // Extraction never ran: the over-budget node carries no evidence and
      // nothing reached the candidate pool.
      expect(run.nodes).toHaveLength(1)
      expect(run.nodes[0]).toMatchObject({ nodeID: "n0", status: "failed" })
      expect(run.nodes[0].evidence).toBeUndefined()
    }),
  )

  it.instance("at max depth hands off WITHOUT any permission prompt", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "REQUERY" }, { choice: "WEB_SEARCH" }])
      const asks: string[] = []
      const deps = baseDeps({
        ask: (permission) => {
          asks.push(permission)
          return Effect.succeed(true)
        },
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: `unexpected ${req.tool}`, bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_depth_1",
        agentName: "explore",
        task: "find the demo",
        config: { banyancode_jev_tree: { enabled: true, maxDepth: 1 } },
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      // Both decisions were made; the at-depth WEB_SEARCH turn never prompted.
      expect(script.state.calls).toBe(2)
      expect(asks).toEqual(["codegraph_staleness", "repository_query", "repository_query"])
      expect(asks).not.toContain("websearch_free")
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toBe("budget:max-depth")
    }),
  )

  it.instance("hands off at maxNodes before any Jev request", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_maxnodes_1",
        agentName: "explore",
        task: "find the demo",
        config: { banyancode_jev_tree: { enabled: true, maxNodes: 1 } },
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(0)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toBe("budget:max-nodes")
      expect(run.nodes).toHaveLength(1)
    }),
  )

  it.instance("hands off at maxJevCalls after exactly one decision", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "REQUERY" }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_maxjev_1",
        agentName: "explore",
        task: "find the demo",
        config: { banyancode_jev_tree: { enabled: true, maxJevCalls: 1 } },
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(1)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toBe("budget:max-jev-calls")
    }),
  )

  it.instance("hands off at runTimeoutMs without any Jev request", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      let ticks = 0
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        now: () => {
          const value = ticks === 0 ? 0 : 10_000
          ticks++
          return value
        },
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_timeout_1",
        agentName: "explore",
        task: "find the demo",
        config: { banyancode_jev_tree: { enabled: true, runTimeoutMs: 1 } },
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(0)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toBe("budget:run-timeout")
    }),
  )

  it.instance("hands off on permission denial without any Jev request", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const deps = baseDeps({
        ask: (permission) => Effect.succeed(permission !== "repository_query"),
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_denied_1",
        agentName: "explore",
        task: "find the demo",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(0)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toContain("permission-denied")
    }),
  )

  it.instance("hands off on a narrow margin even when confidence clears the floor", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      // confidence 0.9 >= 0.8, but top-2 margin = 0.28 - 0.1029 = 0.177 < 0.2.
      const script = jevFetch([{ choice: "CODE_FIND", confidence: 0.9, chosen: 0.28 }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_margin_1",
        agentName: "explore",
        task: "where is the demo?",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(1)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const parts = rows.flatMap((item) => item.parts)
      const run = parts.find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toContain("narrow-margin")
      // The request itself succeeded and settled its activity.
      expect(parts.find((part) => part.type === "jev_activity")).toMatchObject({
        status: "completed",
        choice: "CODE_FIND",
      })
    }),
  )

  it.instance("hands off when the decide seam fails before any request", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        decide: () => Effect.die(new Error("decide seam exploded")),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_decidefail_1",
        agentName: "explore",
        task: "find the demo",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      // The defecting seam never reached the (mock) endpoint.
      expect(script.state.calls).toBe(0)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const parts = rows.flatMap((item) => item.parts)
      const run = parts.find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toBe("jev-decide-failed")
      // Fail-safe settlement: the started activity is terminal, not stuck running.
      expect(parts.find((part) => part.type === "jev_activity")).toMatchObject({ status: "failed" })
    }),
  )

  it.instance("hands off without a request when no Jev activity can start", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: DEMO_QUERY_HIT, bytes: DEMO_QUERY_HIT.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      // Target the USER message: JevActivity.start rejects non-assistant
      // targets, so the activity seam is unavailable for this attempt.
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.userID,
        runID: "run_noactivity_1",
        agentName: "explore",
        task: "find the demo",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(0)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const parts = rows.flatMap((item) => item.parts)
      expect(parts.filter((part) => part.type === "jev_activity")).toHaveLength(0)
      const run = parts.find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.status).toBe("handoff")
      expect(run.stopReason).toContain("activity-unavailable")
    }),
  )

  it.instance("hands off immediately when no code graph has ever been built", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "STOP_WITH_EVIDENCE" }])
      const dispatched: string[] = []
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            dispatched.push(req.tool)
            if (req.tool === "codegraph_staleness")
              return {
                ok: true,
                json: { staleFiles: 0, missingFiles: 0, totalFiles: 0 },
                value: "staleFiles=0 missingFiles=0 totalFiles=0",
                bytes: 40,
              }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_graphmissing_1",
        agentName: "explore",
        task: "find the demo",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(script.state.calls).toBe(0)
      expect(dispatched).toEqual(["codegraph_staleness"])
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toContain("graph-missing")
    }),
  )
})

// jev_run is display-only: MessageV2 lowering must drop it without replaying
// to the model or fabricating a provider tool call.
describe("session.message-v2 jev_run safety", () => {
  const sessionID = SessionID.make("session")
  const jevRunPart: SessionV1.JevRunPart = {
    id: PartID.make("prt_jevrun1"),
    sessionID,
    messageID: MessageID.make("msg_a1"),
    type: "jev_run",
    runID: "run_abc",
    status: "completed",
    stopReason: "JEV_STOP_MARKER",
    nodes: [
      {
        nodeID: "n0",
        actionID: "REPOSITORY_QUERY",
        target: "task",
        status: "done",
        evidence: [{ path: "packages/core/src/demo.ts", lines: "10-12", excerpt: "JEV_EVIDENCE_MARKER" }],
      },
    ],
  }
  const MARKERS = ["jev_run", "run_abc", "JEV_STOP_MARKER", "JEV_EVIDENCE_MARKER", "REPOSITORY_QUERY"]

  const userInfo = (id: string): SessionV1.User =>
    ({
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "user",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      tools: {},
      mode: "",
    }) as unknown as SessionV1.User

  const assistantInfo = (id: string, parentID: string): SessionV1.Assistant =>
    ({
      id,
      sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID,
      modelID: ModelV2.ID.make(model.api.id),
      providerID: model.providerID,
      mode: "",
      agent: "explore",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }) as unknown as SessionV1.Assistant

  test("drops jev_run from assistant model input without replaying or fabricating tool calls", async () => {
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo("msg_u1"),
        parts: [
          { id: PartID.make("prt_p1"), sessionID, messageID: MessageID.make("msg_u1"), type: "text", text: "hello" },
        ],
      },
      {
        info: assistantInfo("msg_a1", "msg_u1"),
        parts: [
          {
            id: PartID.make("prt_p2"),
            sessionID,
            messageID: MessageID.make("msg_a1"),
            type: "text",
            text: "assistant reply",
          },
          jevRunPart,
        ],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const serialized = JSON.stringify(result)
    expect(serialized).toContain("assistant reply")
    for (const marker of MARKERS) expect(serialized).not.toContain(marker)
    const toolParts = result.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type.startsWith("tool")) : [],
    )
    expect(toolParts).toEqual([])
    expect(result).toHaveLength(2)
  })

  test("a jev_run-only assistant turn converts to no model message at all", async () => {
    const input: SessionV1.WithParts[] = [{ info: assistantInfo("msg_a2", "msg_u2"), parts: [jevRunPart] }]
    const result = await MessageV2.toModelMessages(input, model)
    expect(result).toEqual([])
  })
})
