process.env.BANYANCODE_ENABLE = "1"

import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { BanyanConfigService } from "@opencode-ai/core/banyancode/banyan-config"
import { Jev } from "@opencode-ai/core/banyancode/jev"
import { JevMemory } from "@opencode-ai/core/banyancode/jev-memory"
import type { MemoryPayloadV1 } from "@opencode-ai/core/banyancode/memory-payload"
import { MemoryTools } from "@opencode-ai/core/tool/memory"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { tmpdir } from "../fixture/tmpdir"

const FAKE_KEY = "test-fake-jev-key"
const QUERY = "why did we switch storage?"
const PROTECTED_KEY = "decision:protected"

const payloadFor = (overrides: Partial<MemoryPayloadV1>): MemoryPayloadV1 => ({
  kind: "observation",
  title: "note",
  body: "body",
  source: { type: "system" },
  confidence: "low",
  importance: "low",
  status: "active",
  ...overrides,
})

const seedThree = Effect.gen(function* () {
  const repo = yield* Banyan.MemoryRepo
  yield* repo.put({
    id: "mem-protected",
    key: PROTECTED_KEY,
    value: payloadFor({
      kind: "decision",
      title: "Protected decision",
      body: "PROTECTEDMARKER switched storage rationale, keep this pinned.",
      source: { type: "user" },
      confidence: "high",
      importance: "high",
    }),
    scope: "global",
  })
  yield* repo.put({
    id: "mem-alpha",
    key: "decision:alpha",
    value: payloadFor({
      kind: "decision",
      title: "Alpha note",
      body: "ALPHAMARKER switched storage working note.",
      source: { type: "agent" },
      confidence: "medium",
      importance: "medium",
    }),
    scope: "global",
  })
  yield* repo.put({
    id: "mem-bravo",
    key: "observation:bravo",
    value: payloadFor({
      kind: "observation",
      title: "Bravo note",
      body: "BRAVOMARKER switched storage low-signal note.",
      source: { type: "system" },
      confidence: "low",
      importance: "low",
    }),
    scope: "global",
  })
})

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })

const legendFor = (): Record<string, string> =>
  Object.fromEntries(JevMemory.UTILITY_LEVELS.map((label, i) => [String(i), label]))

const probsFor = (level: number): Record<string, number> =>
  Object.fromEntries(JevMemory.UTILITY_LEVELS.map((_, i) => [String(i), i === level ? 1 : 0]))

const answerFor = (noul: number, score: number, confidence = 0.9) => ({
  relevance: { type: "noul", noul },
  utility: {
    type: "score",
    score,
    legend: legendFor(),
    probabilities: probsFor(Math.round(score)),
    confidence,
  },
})

const keyForMarker = (marker: string): string => {
  if (marker === "ALPHAMARKER") return "decision:alpha"
  if (marker === "BRAVOMARKER") return "observation:bravo"
  return PROTECTED_KEY
}

// Scores the baseline-LAST unprotected entry high so a working rerank
// genuinely reverses the unprotected lexical order.
const reversingHandler = (baselineKeys: string[]) => {
  const unprotected = baselineKeys.filter((key) => key !== PROTECTED_KEY)
  const last = unprotected[unprotected.length - 1]
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { state: string }
    const marker =
      ["ALPHAMARKER", "BRAVOMARKER", "PROTECTEDMARKER"].find((m) => body.state.includes(m)) ?? "ALPHAMARKER"
    const high = keyForMarker(marker) === last
    return jsonResponse({ answers: answerFor(high ? 0.95 : 0.1, high ? 4 : 0) })
  }
}

const outputStoreMock = Layer.mock(ToolOutputStore.Service, {
  bound: (input: { output: unknown }) =>
    Effect.sync(() => ({ output: input.output as never, outputPaths: [] as unknown as readonly [] })),
})

const registryBase = ToolRegistry.layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(outputStoreMock),
)

const allowPermission = Layer.succeed(
  PermissionV2.Service,
  {
    assert: () => Effect.void,
    ask: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.void,
    forSession: () => Effect.void,
    list: () => Effect.succeed([]),
  } as never,
)

const denyPermission = Layer.succeed(
  PermissionV2.Service,
  {
    assert: () => Effect.fail(new PermissionV2.DeniedError({ rules: [] })),
    ask: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.void,
    forSession: () => Effect.void,
    list: () => Effect.succeed([]),
  } as never,
)

const configLayerFor = (config: Record<string, unknown>) =>
  Layer.succeed(BanyanConfigService.Service, {
    get: () => Effect.succeed(config),
    getGlobal: () => Effect.succeed(config),
    update: () => Effect.succeed({}),
    updateAgentOverride: () => Effect.succeed({}),
    getAgentOverrides: () => Effect.succeed(undefined),
    updateAgentPrompt: () => Effect.succeed({}),
  } as never)

const enabledConfig = {
  banyancode_jev_enabled: true,
  banyancode_jev_features: { "context-rerank": true },
}

const disabledConfig = { banyancode_jev_enabled: false }

// Configuration mount pipeline: cfg layer is built BEFORE registration via
// Layer.provideMerge (same shape as existing core shared-mem tests). The
// optional BanyanConfigService is captured at registration time inside
// MemoryTools.locationLayer, so omitting configLayer models "absent service".
const buildToolLayer = (opts: {
  memoryLayer: Layer.Layer<Banyan.MemoryRepo>
  permissionLayer: Layer.Layer<PermissionV2.Service>
  configLayer?: Layer.Layer<BanyanConfigService.Service>
}) =>
  opts.configLayer
    ? MemoryTools.locationLayer.pipe(
        Layer.provideMerge(registryBase),
        Layer.provideMerge(opts.permissionLayer),
        Layer.provideMerge(opts.memoryLayer),
        Layer.provideMerge(opts.configLayer),
      )
    : MemoryTools.locationLayer.pipe(
        Layer.provideMerge(registryBase),
        Layer.provideMerge(opts.permissionLayer),
        Layer.provideMerge(opts.memoryLayer),
      )

type SearchEntries = Array<{ key: string }>

const settleSearch = (
  input: { query: string; runID?: string; sessionID: string },
): Effect.Effect<{ entries: SearchEntries; raw: unknown }, unknown, ToolRegistry.Service> =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const materialized = yield* registry.materialize()
    const settlement = yield* materialized.settle({
      sessionID: SessionV2.ID.make(input.sessionID),
      runID: input.runID,
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.make(`msg_${randomUUID()}`),
      call: { type: "tool-call", id: randomUUID(), name: MemoryTools.name_search, input: { query: input.query } },
    })
    if (settlement.result.type === "error") {
      return yield* Effect.fail(new Error(`unexpected tool error: ${settlement.result.value}`))
    }
    const output = (settlement as { output?: { structured?: unknown } }).output?.structured as
      | { entries: Array<{ key: string }> }
      | undefined
    if (!output) return yield* Effect.fail(new Error("missing settlement output"))
    return { entries: output.entries, raw: output }
  })

const settleSearchExit = (
  input: { query: string; runID?: string; sessionID: string },
): Effect.Effect<ToolRegistry.Settlement, unknown, ToolRegistry.Service> =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const materialized = yield* registry.materialize()
    return yield* materialized.settle({
      sessionID: SessionV2.ID.make(input.sessionID),
      runID: input.runID,
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.make(`msg_${randomUUID()}`),
      call: { type: "tool-call", id: randomUUID(), name: MemoryTools.name_search, input: { query: input.query } },
    })
  })

let originalFetch = globalThis.fetch
let originalKey: string | undefined
let originalTypesafeKey: string | undefined

const installFetch = (handler: Jev.Fetch) => {
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof fetch>) => handler(String(args[0]), args[1]),
    { preconnect: originalFetch.preconnect },
  )
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalKey = process.env.BANYANCODE_JEV_API_KEY
  originalTypesafeKey = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.BANYANCODE_JEV_API_KEY
  else process.env.BANYANCODE_JEV_API_KEY = originalKey
  Jev.resetJevStateForTests()
  if (originalTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = originalTypesafeKey
})

describe("jev-memory-search tool integration", () => {
  test("enabled tool reranks unprotected entries and keeps protected slot (same-DB baseline)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "search-rerank.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = buildToolLayer({
      memoryLayer,
      permissionLayer: allowPermission,
      configLayer: configLayerFor(enabledConfig),
    })
    let fetchCalls = 0
    let handler: (url: string, init?: RequestInit) => Promise<Response> = async () =>
      jsonResponse({ answers: answerFor(0.1, 0) })
    installFetch(async (url: string, init?: RequestInit) => {
      fetchCalls += 1
      return handler(url, init)
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        yield* seedThree
        // Baseline WITHOUT key on the SAME DB: lexical order, zero paid calls.
        delete process.env.BANYANCODE_JEV_API_KEY
        const before = fetchCalls
        const baseline = yield* settleSearch({ query: QUERY, sessionID: "ses_rerank_base", runID: "turn-base" })
        expect(baseline.entries.length).toBe(3)
        expect(fetchCalls - before).toBe(0)
        const baselineKeys = baseline.entries.map((e) => e.key)

        // Enabled WITH key: reversing stub must genuinely reverse unprotected slots.
        process.env.BANYANCODE_JEV_API_KEY = FAKE_KEY
        handler = reversingHandler(baselineKeys)
        const reranked = yield* settleSearch({ query: QUERY, sessionID: "ses_rerank_base", runID: "turn-rerank" })
        expect(fetchCalls - before).toBeGreaterThan(0)
        expect([...reranked.entries.map((e) => e.key)].sort()).toEqual([...baselineKeys].sort())
        expect(reranked.entries.map((e) => e.key).indexOf(PROTECTED_KEY)).toBe(baselineKeys.indexOf(PROTECTED_KEY))
        const baselineFree = baselineKeys.filter((k) => k !== PROTECTED_KEY)
        const rerankedFree = reranked.entries.map((e) => e.key).filter((k) => k !== PROTECTED_KEY)
        expect(rerankedFree).toEqual([...baselineFree].reverse())
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("no-key keeps lexical order byte-identical with zero fetch", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "search-nokey.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = buildToolLayer({
      memoryLayer,
      permissionLayer: allowPermission,
      configLayer: configLayerFor(enabledConfig),
    })
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      return jsonResponse({ answers: answerFor(0.95, 4) })
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        yield* seedThree
        delete process.env.BANYANCODE_JEV_API_KEY
        delete process.env.TYPESAFE_API_KEY
        const first = yield* settleSearch({ query: QUERY, sessionID: "ses_nokey", runID: "turn-1" })
        const second = yield* settleSearch({ query: QUERY, sessionID: "ses_nokey", runID: "turn-2" })
        expect(second.entries.map((e) => e.key)).toEqual(first.entries.map((e) => e.key))
        expect(JSON.stringify(second.raw)).toBe(JSON.stringify(first.raw))
        expect(fetchCalls).toBe(0)
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("global disable keeps lexical order with zero fetch even with key", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "search-disabled.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = buildToolLayer({
      memoryLayer,
      permissionLayer: allowPermission,
      configLayer: configLayerFor(disabledConfig),
    })
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      return jsonResponse({ answers: answerFor(0.95, 4) })
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        yield* seedThree
        process.env.BANYANCODE_JEV_API_KEY = FAKE_KEY
        const first = yield* settleSearch({ query: QUERY, sessionID: "ses_disabled", runID: "turn-1" })
        const second = yield* settleSearch({ query: QUERY, sessionID: "ses_disabled", runID: "turn-2" })
        expect(second.entries.map((e) => e.key)).toEqual(first.entries.map((e) => e.key))
        expect(JSON.stringify(second.raw)).toBe(JSON.stringify(first.raw))
        expect(fetchCalls).toBe(0)
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("uncertain model answers preserve entries while still calling fetch", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "search-uncertain.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = buildToolLayer({
      memoryLayer,
      permissionLayer: allowPermission,
      configLayer: configLayerFor(enabledConfig),
    })
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      // Indecisive Noul (0.5) carries no signal -> combinedScore undefined.
      return jsonResponse({ answers: answerFor(0.5, 4, 0.95) })
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        yield* seedThree
        delete process.env.BANYANCODE_JEV_API_KEY
        const baseline = yield* settleSearch({ query: QUERY, sessionID: "ses_uncertain", runID: "turn-base" })
        process.env.BANYANCODE_JEV_API_KEY = FAKE_KEY
        const before = fetchCalls
        const result = yield* settleSearch({ query: QUERY, sessionID: "ses_uncertain", runID: "turn-uncertain" })
        expect(fetchCalls - before).toBeGreaterThan(0)
        expect(result.entries.map((e) => e.key)).toEqual(baseline.entries.map((e) => e.key))
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("permission denial performs zero fetch and returns error settlement", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "search-denied.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = buildToolLayer({
      memoryLayer,
      permissionLayer: denyPermission,
      configLayer: configLayerFor(enabledConfig),
    })
    let fetchCalls = 0
    installFetch(async () => {
      fetchCalls += 1
      return jsonResponse({ answers: answerFor(0.95, 4) })
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        yield* seedThree
        process.env.BANYANCODE_JEV_API_KEY = FAKE_KEY
        const settlement = yield* settleSearchExit({ query: QUERY, sessionID: "ses_denied", runID: "turn-denied" })
        expect(settlement.result.type).toBe("error")
        expect(fetchCalls).toBe(0)
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("per-turn budget uses runID scope, not visibility scope", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "search-budget.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
    const toolLayer = buildToolLayer({
      memoryLayer,
      permissionLayer: allowPermission,
      configLayer: configLayerFor({
        ...enabledConfig,
        banyancode_jev_budget: { perTurnCalls: 2 },
        banyancode_jev_client: { cacheMaxEntries: 0 },
      }),
    })
    let fetchCalls = 0
    installFetch(async (_url: string, init?: RequestInit) => {
      fetchCalls += 1
      const body = JSON.parse(String(init?.body)) as { state: string }
      const marker =
        ["ALPHAMARKER", "BRAVOMARKER", "PROTECTEDMARKER"].find((m) => body.state.includes(m)) ?? "ALPHAMARKER"
      const high = keyForMarker(marker) === "observation:bravo"
      return jsonResponse({ answers: answerFor(high ? 0.95 : 0.1, high ? 4 : 0) })
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* DatabaseMigration.apply((yield* Database.Service).db)
        yield* seedThree
        process.env.BANYANCODE_JEV_API_KEY = FAKE_KEY
        // Missing runID with a per-turn budget is fail-safed off: zero fetch.
        const noRun = yield* settleSearch({ query: QUERY, sessionID: "ses_budget" })
        expect(fetchCalls).toBe(0)
        expect(noRun.entries.length).toBe(3)

        // Same runID exhausts the 2-call turn budget on the second use.
        const first = yield* settleSearch({ query: QUERY, sessionID: "ses_budget", runID: "turn-A" })
        const afterFirst = fetchCalls
        expect(afterFirst).toBeGreaterThan(0)
        const second = yield* settleSearch({ query: QUERY, sessionID: "ses_budget", runID: "turn-A" })
        expect(fetchCalls).toBe(afterFirst)
        expect(second.entries.map((e) => e.key)).toEqual(noRun.entries.map((e) => e.key))

        // Different runID gets a fresh turn budget even with same visibility.
        const third = yield* settleSearch({ query: QUERY, sessionID: "ses_budget", runID: "turn-B" })
        expect(fetchCalls).toBeGreaterThan(afterFirst)
        expect(third.entries.length).toBe(3)
        void first
      }).pipe(Effect.provide(toolLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
