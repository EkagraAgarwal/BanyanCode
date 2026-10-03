import { describe, expect, test, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import { BanyanConfigService } from "@opencode-ai/core/banyancode/banyan-config"
import { JevMemory } from "@opencode-ai/core/banyancode/jev-memory"
import { Jev } from "@opencode-ai/core/banyancode/jev"
import type { MemoryPayloadV1 } from "@opencode-ai/core/banyancode/memory-payload"
import type { MemoryEntry } from "@opencode-ai/core/banyancode/types"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const KEYED_ENV = { BANYANCODE_JEV_API_KEY: "test-key" }

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

const entryFor = (key: string, value: MemoryPayloadV1, tags: string[] = []): MemoryEntry => ({
  id: `id-${key}`,
  key,
  value,
  context: undefined,
  tags,
  scope: "global",
  sessionID: undefined,
  createdAt: 1_700_000_000_000,
  expiresAt: undefined,
  agentID: "test",
  version: 1,
  updatedAt: 1_700_000_000_000,
  namespace: undefined,
  kind: value.kind,
  title: value.title,
  body: value.body,
  status: "active",
})

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

afterEach(() => {
  Jev.resetJevStateForTests()
})

describe("jev-memory helper", () => {
  test("buildCandidateState is one query+candidate per state", () => {
    const a = entryFor("a", payloadFor({ title: "Alpha", body: "alpha body" }))
    const b = entryFor("b", payloadFor({ title: "Bravo", body: "bravo body" }))
    const sa = JevMemory.buildCandidateState("why switch?", a)
    const sb = JevMemory.buildCandidateState("why switch?", b)
    expect(sa).toContain("why switch?")
    expect(sa).toContain("candidate: a")
    expect(sa).not.toContain("candidate: b")
    expect(sb).toContain("candidate: b")
    expect(sa).not.toEqual(sb)
  })

  test("relevanceQuestions batches Noul + Score with valid Score levels", () => {
    const questions = JevMemory.relevanceQuestions()
    expect(Object.keys(questions).sort()).toEqual(["relevance", "utility"])
    expect(questions.relevance?.type).toBe("noul")
    const utility = questions.utility
    expect(utility?.type).toBe("score")
    if (utility?.type !== "score") throw new Error("expected score question")
    expect(utility.criteria.length).toBeGreaterThanOrEqual(2)
    expect(utility.criteria.length).toBeLessThanOrEqual(10)
    expect(new Set(utility.criteria).size).toBe(utility.criteria.length)
  })

  test("combinedScore enforces the uncertainty gate", () => {
    const gated = (noul: number, confidence: number) =>
      JevMemory.combinedScore({
        relevance: { type: "noul", noul },
        utility: { type: "score", score: 4, legend: legendFor(), probabilities: probsFor(4), confidence },
      } as unknown as Record<string, Jev.Answer>)
    expect(gated(0.95, 0.9)).toBeCloseTo((0.95 + 1) / 2, 10)
    expect(gated(0.1, 0.9)).toBeCloseTo((0.1 + 1) / 2, 10)
    // Low Score confidence carries no signal even with decisive Noul.
    expect(gated(0.95, 0.5)).toBeUndefined()
    expect(gated(0.95, 0.79)).toBeUndefined()
    expect(gated(0.95, 0.8)).toBeDefined()
    // Indecisive Noul near 0.5 carries no signal even with high confidence.
    expect(gated(0.5, 0.9)).toBeUndefined()
    expect(gated(0.31, 0.9)).toBeUndefined()
    expect(gated(0.3, 0.9)).toBeDefined()
    expect(gated(0.7, 0.9)).toBeDefined()
  })

  test("buildCandidateState bounds query/title/key/body lengths", () => {
    const long = "x".repeat(10_000)
    const state = JevMemory.buildCandidateState(long, entryFor(long, payloadFor({ title: long, body: long })))
    expect(state.length).toBeLessThan(
      JevMemory.MAX_STATE_QUERY_CHARS + JevMemory.MAX_STATE_TITLE_CHARS + JevMemory.MAX_STATE_KEY_CHARS + JevMemory.MAX_STATE_BODY_CHARS + 500,
    )
    expect(state).toContain("…")
  })

  test("isProtected pins importance-high and pinned/critical tags", () => {
    expect(JevMemory.isProtected(entryFor("p", payloadFor({ importance: "high" })))).toBe(true)
    expect(JevMemory.isProtected(entryFor("t", payloadFor({}), ["pinned"]))).toBe(true)
    expect(JevMemory.isProtected(entryFor("c", payloadFor({}), ["critical"]))).toBe(true)
    expect(JevMemory.isProtected(entryFor("n", payloadFor({})))).toBe(false)
  })

  test("scoreCandidate hits the client boundary with injected fetch", async () => {
    let captured: { state: string; questions: Record<string, { type: string }> } | undefined
    const fetch: Jev.Fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, { type: string }> }
      return jsonResponse({ answers: answerFor(0.8, 3) })
    }
    const score = await JevMemory.scoreCandidate({
      query: "why switch?",
      entry: entryFor("decision:switch-storage", payloadFor({ title: "Switch", body: "Switched storage." })),
      env: KEYED_ENV,
      fetch,
      sessionID: "mem-boundary",
      scope: "global",
    })
    expect(score).toBeCloseTo(0.775, 10)
    expect(captured?.state).toContain("why switch?")
    expect(captured?.state).toContain("decision:switch-storage")
    expect(Object.keys(captured?.questions ?? {}).sort()).toEqual(["relevance", "utility"])
    expect(captured?.questions.relevance?.type).toBe("noul")
    expect(captured?.questions.utility?.type).toBe("score")
    expect(Jev.usage("mem-boundary").requests).toBeGreaterThanOrEqual(1)
  })

  test("scoreCandidate returns undefined on failure and never throws", async () => {
    const failing: Jev.Fetch = async () => new Response("busy", { status: 503 })
    const score = await JevMemory.scoreCandidate({
      query: "q",
      entry: entryFor("k", payloadFor({})),
      env: KEYED_ENV,
      fetch: failing,
      sessionID: "mem-failing",
    })
    expect(score).toBeUndefined()
    const throwing: Jev.Fetch = async () => {
      throw new Error("boom")
    }
    await expect(
      JevMemory.scoreCandidate({ query: "q", entry: entryFor("k", payloadFor({})), env: KEYED_ENV, fetch: throwing }),
    ).resolves.toBeUndefined()
  })
})

const jevEnabledLayer = (features: Record<string, boolean>, budget?: { perTurnCalls: number }) =>
  Layer.succeed(BanyanConfigService.Service, {
    get: () =>
      Effect.succeed({
        banyancode_jev_enabled: true,
        banyancode_jev_features: features,
        ...(budget === undefined ? {} : { banyancode_jev_budget: budget }),
      }),
    getGlobal: () =>
      Effect.succeed({
        banyancode_jev_enabled: true,
        banyancode_jev_features: features,
        ...(budget === undefined ? {} : { banyancode_jev_budget: budget }),
      }),
    update: () => Effect.succeed({}),
    updateAgentOverride: () => Effect.succeed({}),
    getAgentOverrides: () => Effect.succeed(undefined),
    updateAgentPrompt: () => Effect.succeed({}),
  } satisfies BanyanConfigService.Interface)

const seedThree = Effect.gen(function* () {
  const repo = yield* Banyan.MemoryRepo
  yield* repo.put({
    id: "mem-protected",
    key: "decision:protected",
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

const QUERY = "why did we switch storage?"
const PROTECTED_KEY = "decision:protected"

const markerForKey = (key: string): string => {
  if (key === "decision:alpha") return "ALPHAMARKER"
  if (key === "observation:bravo") return "BRAVOMARKER"
  return "PROTECTEDMARKER"
}

const keyForMarker = (marker: string): string => {
  if (marker === "ALPHAMARKER") return "decision:alpha"
  if (marker === "BRAVOMARKER") return "observation:bravo"
  return PROTECTED_KEY
}

// Scores the baseline-LAST unprotected entry high and every other entry low,
// so a working rerank genuinely reverses the unprotected lexical order.
const reversingFetch = (baselineKeys: string[]): { fetch: Jev.Fetch; calls: () => number } => {
  const unprotected = baselineKeys.filter((key) => key !== PROTECTED_KEY)
  const last = unprotected[unprotected.length - 1]
  let calls = 0
  const fetch: Jev.Fetch = async (_url, init) => {
    calls += 1
    const body = JSON.parse(String(init?.body)) as { state: string }
    const marker =
      ["ALPHAMARKER", "BRAVOMARKER", "PROTECTEDMARKER"].find((m) => body.state.includes(m)) ?? "ALPHAMARKER"
    const high = keyForMarker(marker) === last
    return jsonResponse({ answers: answerFor(high ? 0.95 : 0.1, high ? 4 : 0) })
  }
  return { fetch, calls: () => calls }
}

const countedFetch = (fetch: Jev.Fetch): { fetch: Jev.Fetch; calls: () => number } => {
  let calls = 0
  return {
    fetch: async (url, init) => {
      calls += 1
      return fetch(url, init)
    },
    calls: () => calls,
  }
}

describe("memory-retrieval jev rerank", () => {
  test("disabled without key/config keeps lexical order byte-for-byte", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "jev-memory-disabled.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)
        yield* seedThree
        const retrieval = yield* Banyan.MemoryRetrieval
        const baseline = yield* retrieval.retrieve({ query: QUERY, env: {} })
        expect(baseline.skipped).toBe(false)
        expect(baseline.hits.length).toBe(3)
        const again = yield* retrieval.retrieve({ query: QUERY, env: {} })
        expect(again.skipped).toBe(false)
        expect(again.hits.map((h) => h.entry.key)).toEqual(baseline.hits.map((h) => h.entry.key))
        expect(again.totalHits).toBe(baseline.totalHits)
        expect(again.reasoning).toEqual(baseline.reasoning)
        expect(again.reasoning.some((r) => r.startsWith("jev-"))).toBe(false)
        expect(again.hits.every((h) => h.reasons.every((r) => !r.startsWith("jev=")))).toBe(true)
      }).pipe(
        Effect.provide(Banyan.memoryRetrievalLayer),
        Effect.provide(Banyan.memoryRepoLayer),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("explicit global disable keeps lexical order even with key+fetch", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "jev-memory-globaloff.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const configLayer = Layer.succeed(BanyanConfigService.Service, {
      get: () => Effect.succeed({ banyancode_jev_enabled: false }),
      getGlobal: () => Effect.succeed({ banyancode_jev_enabled: false }),
      update: () => Effect.succeed({}),
      updateAgentOverride: () => Effect.succeed({}),
      getAgentOverrides: () => Effect.succeed(undefined),
      updateAgentPrompt: () => Effect.succeed({}),
    } satisfies BanyanConfigService.Interface)
    const calls = countedFetch(async () => jsonResponse({ answers: answerFor(1, 4) }))
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)
        yield* seedThree
        const retrieval = yield* Banyan.MemoryRetrieval
        const baseline = yield* retrieval.retrieve({ query: QUERY, env: {} })
        const result = yield* retrieval.retrieve({
          query: QUERY,
          env: KEYED_ENV,
          fetch: calls.fetch,
        })
        expect(result.hits.map((h) => h.entry.key)).toEqual(baseline.hits.map((h) => h.entry.key))
        expect(result.totalHits).toBe(baseline.totalHits)
        expect(calls.calls()).toBe(0)
      }).pipe(
        Effect.provide(Banyan.memoryRetrievalLayer),
        Effect.provide(Layer.merge(Banyan.memoryRepoLayer, configLayer)),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("enabled rerank reorders rerankable slots, anchors pinned, preserves all", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "jev-memory-rerank.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const configLayer = jevEnabledLayer({ "context-rerank": true })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)
        yield* seedThree
        const retrieval = yield* Banyan.MemoryRetrieval
        // ORIGINAL no-key lexical order on the same DB — never assume protected-first.
        const baseline = yield* retrieval.retrieve({ query: QUERY, env: {} })
        expect(baseline.skipped).toBe(false)
        expect(baseline.hits.length).toBe(3)
        const baselineKeys = baseline.hits.map((h) => h.entry.key)
        // Scores the baseline-LAST unprotected entry high so a working rerank
        // genuinely reverses the unprotected lexical order.
        const { fetch } = reversingFetch(baselineKeys)
        const result = yield* retrieval.retrieve({
          query: QUERY,
          env: KEYED_ENV,
          fetch,
          sessionID: "mem-rerank",
          jevScope: "mem-rerank-turn",
        })
        expect(result.skipped).toBe(false)
        expect(result.intent).toBe("history")
        expect(result.totalHits).toBe(3)
        // Same entry set, nothing deleted or promoted.
        expect([...result.hits.map((h) => h.entry.key)].sort()).toEqual([...baselineKeys].sort())
        // Pinned protected entry keeps its exact lexical slot.
        expect(result.hits.map((h) => h.entry.key).indexOf(PROTECTED_KEY)).toBe(baselineKeys.indexOf(PROTECTED_KEY))
        // Unprotected slots are reversed relative to baseline.
        const baselineFree = baselineKeys.filter((key) => key !== PROTECTED_KEY)
        const resultFree = result.hits.map((h) => h.entry.key).filter((key) => key !== PROTECTED_KEY)
        expect(resultFree).toEqual([...baselineFree].reverse())
        const protectedHit = result.hits.find((h) => h.entry.key === PROTECTED_KEY)
        expect(protectedHit?.reasons.some((r) => r.startsWith("jev="))).toBe(false)
        expect(result.hits.filter((h) => h.entry.key !== PROTECTED_KEY).every((h) => h.reasons.some((r) => r.startsWith("jev=")))).toBe(true)
        expect(result.reasoning.some((r) => r.startsWith("jev-rerank:"))).toBe(true)
      }).pipe(
        Effect.provide(Banyan.memoryRetrievalLayer),
        Effect.provide(Layer.merge(Banyan.memoryRepoLayer, configLayer)),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })

  test("Jev failure preserves lexical order", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "jev-memory-failure.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const configLayer = jevEnabledLayer({ "context-rerank": true })
    const failing: Jev.Fetch = async () => new Response("busy", { status: 503 })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* DatabaseMigration.apply(db)
        }).pipe(Effect.provide(dbLayer), Effect.scoped)
        yield* seedThree
        const retrieval = yield* Banyan.MemoryRetrieval
        // ORIGINAL no-key lexical order on the same DB — never assume protected-first.
        const baseline = yield* retrieval.retrieve({ query: QUERY, env: {} })
        const result = yield* retrieval.retrieve({
          query: "why did we switch storage?",
          env: KEYED_ENV,
          fetch: failing,
          sessionID: "mem-rerank-fail",
        })
        expect(result.hits.map((h) => h.entry.key)).toEqual(baseline.hits.map((h) => h.entry.key))
        expect(result.totalHits).toBe(baseline.totalHits)
        expect(result.reasoning.some((r) => r.startsWith("jev-rerank-skipped:"))).toBe(true)
      }).pipe(
        Effect.provide(Banyan.memoryRetrievalLayer),
        Effect.provide(Layer.merge(Banyan.memoryRepoLayer, configLayer)),
        Effect.provide(dbLayer),
        Effect.scoped,
      ),
    )
  })
})
