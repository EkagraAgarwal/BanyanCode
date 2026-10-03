import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { Jev } from "@opencode-ai/core/banyancode/jev"
import type { Info as BanyanConfigInfo } from "@opencode-ai/core/v1/config/banyan-config"
import { Effect, Layer } from "effect"
import type { ModelMessage } from "ai"
import { Session as SessionNs } from "@/session/session"
import { JevExplorer } from "@/session/jev-explorer"
import { MessageID, SessionID } from "@/session/schema"
import type { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"

// Dedicated regression coverage for the explorer fixes: exact raw web-span
// verification while the display excerpt stays normalized, bounded
// idle/skipped streak handoff, abort/scope threading into Jev.decide, and a
// bounded advisory evidence handoff for the V1 caller. Mock fetch only — no
// paid or real Jev request is ever made.
const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Database.defaultLayer))

// Session+Database fixture setup stalls on Windows independently of the
// deadline-bounded engine. Keep a finite fixture budget without weakening assertions.
const TIMEOUT_MS = 10_000

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

interface ScriptedAnswer {
  readonly choice: string
  readonly confidence?: number
  readonly chosen?: number
}

const jevFetch = (script: ScriptedAnswer[]) => {
  let index = 0
  const fetcher: Jev.Fetch = async (_url, init) => {
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
  return { fetch: fetcher }
}

const healthyStaleness: JevExplorer.ToolOutcome = {
  ok: true,
  json: { staleFiles: 0, missingFiles: 0, totalFiles: 100 },
  value: "staleFiles=0 missingFiles=0 totalFiles=100",
  bytes: 40,
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
  return { sessionID, userID, assistantID }
})

const baseDeps = (overrides: Partial<JevExplorer.Deps> = {}): JevExplorer.Deps => ({
  ask: () => Effect.succeed(true),
  call: () => Effect.succeed({ ok: false, value: "unexpected call", bytes: 0 }),
  verifyFile: () => Effect.succeed(true),
  jev: { fetch: jevFetch([{ choice: "HANDOFF_TO_LLM" }]).fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
  ...overrides,
})

void ((): readonly ModelMessage[] => [])()

describe("jev-explorer regression", () => {
  it.instance("verifies a web citation by its exact raw span while the display excerpt stays normalized", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "WEB_SEARCH" }, { choice: "WEB_FETCH" }, { choice: "STOP_WITH_EVIDENCE" }])
      // Heavy whitespace/newlines: the normalized display excerpt can never
      // string-match this raw payload, so the old excerpt-includes check fails.
      const raw = `hello   world\n\nthis\tis   the   fetched   page\n${"filler text here. ".repeat(30)}`
      const url = "https://example.com/docs/page"
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query") return { ok: true, value: "overview with no file refs", bytes: 28 }
            if (req.tool === "websearch_free")
              return { ok: true, value: `top result: ${url} — relevant docs`, bytes: 60 }
            if (req.tool === "webfetch") return { ok: true, value: raw, bytes: raw.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_webraw_1",
        agentName: "explore",
        task: "what do the hosted docs say?",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("completed")
      if (outcome.type !== "completed") return
      expect(outcome.answer).toContain(url)
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      const excerpt = run.nodes.flatMap((node) => node.evidence ?? []).find((entry) => entry.path === url)?.excerpt
      expect(excerpt).toBeDefined()
      expect(excerpt).not.toContain("\n")
      expect(excerpt!.length).toBeLessThanOrEqual(300)
      void session
    }),
    TIMEOUT_MS,
  )

  it.instance("hands off when a web fetch yields no verifiable raw span", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "WEB_SEARCH" }, { choice: "WEB_FETCH" }, { choice: "STOP_WITH_EVIDENCE" }])
      const url = "https://example.com/docs/empty"
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query") return { ok: true, value: "overview with no file refs", bytes: 28 }
            if (req.tool === "websearch_free")
              return { ok: true, value: `top result: ${url} — relevant docs`, bytes: 60 }
            if (req.tool === "webfetch") return { ok: true, value: "", bytes: 0 }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_webempty_1",
        agentName: "explore",
        task: "what do the hosted docs say?",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
    }),
    TIMEOUT_MS,
  )

  it.instance("hands off after four consecutive skipped iterations without spending every budget", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn
      const script = jevFetch([
        { choice: "CODE_FIND" },
        { choice: "CODE_FIND" },
        { choice: "CODE_FIND" },
        { choice: "CODE_FIND" },
        { choice: "STOP_WITH_EVIDENCE" },
      ])
      let decideCalls = 0
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query") return { ok: true, value: "nothing actionable here", bytes: 24 }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        decide: (input) =>
          Effect.promise(async () => {
            decideCalls++
            return Jev.decide(input)
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_idle_1",
        agentName: "explore",
        task: "vague task with no extractable candidates",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(decideCalls).toBe(4)
      const session = yield* SessionNs.Service
      const rows = yield* session.messages({ sessionID: turn.sessionID })
      const run = rows
        .flatMap((item) => item.parts)
        .find((part) => part.type === "jev_run") as SessionV1.JevRunPart
      expect(run.stopReason).toBe("idle-streak: no progress")
    }),
    TIMEOUT_MS,
  )

  it.instance("threads the abort signal, sessionID, and runID scope into every Jev request", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn
      const controller = new AbortController()
      const seen: Jev.DecideInput[] = []
      const script = jevFetch([{ choice: "HANDOFF_TO_LLM" }])
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query")
              return { ok: true, value: "nothing actionable here", bytes: 24 }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        decide: (input) =>
          Effect.promise(async () => {
            seen.push(input)
            return Jev.decide(input)
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_scope_9",
        agentName: "explore",
        task: "threading check",
        config: TREE_CONFIG,
        env: KEY_ENV,
        abort: controller.signal,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      expect(seen.length).toBeGreaterThan(0)
      for (const input of seen) {
        expect(input.signal).toBe(controller.signal)
        expect(input.sessionID).toBe(turn.sessionID)
        expect(input.scope).toBe("run_scope_9")
      }
    }),
    TIMEOUT_MS,
  )

  it.instance("carries a bounded advisory evidence array on handoff for the V1 caller", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurn
      const script = jevFetch([{ choice: "HANDOFF_TO_LLM" }])
      const hit = Array.from({ length: 12 }, (_, index) => `packages/core/src/mod${index}.ts:${index + 1}`).join(" ")
      const deps = baseDeps({
        call: (req) =>
          Effect.sync(() => {
            if (req.tool === "codegraph_staleness") return healthyStaleness
            if (req.tool === "repository_query") return { ok: true, value: `slices: ${hit}`, bytes: hit.length }
            return { ok: false, value: "unreachable", bytes: 0 }
          }),
        jev: { fetch: script.fetch, apiKey: "test-key", endpoint: JEV_ENDPOINT },
      })
      const outcome = yield* JevExplorer.attempt({
        sessionID: turn.sessionID,
        messageID: turn.assistantID,
        runID: "run_handoffev_1",
        agentName: "explore",
        task: "collect pointers",
        config: TREE_CONFIG,
        env: KEY_ENV,
        deps,
      })
      expect(outcome.type).toBe("handoff")
      if (outcome.type !== "handoff") return
      const evidence = outcome.evidence ?? []
      expect(evidence.length).toBeGreaterThan(0)
      expect(evidence.length).toBeLessThanOrEqual(8)
      for (const entry of evidence) {
        expect(typeof entry.path).toBe("string")
        expect(Object.keys(entry).sort()).toEqual(
          Object.keys(entry)
            .filter((key) => ["path", "lines", "excerpt", "graphVersion"].includes(key))
            .sort(),
        )
      }
    }),
    TIMEOUT_MS,
  )
})
