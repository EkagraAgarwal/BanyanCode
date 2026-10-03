import { beforeEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Jev } from "../../src/banyancode/jev"
import { BanyanConfig } from "../../src/v1/config/banyan-config"

beforeEach(() => {
  Jev.resetJevStateForTests()
})

const INPUT = {
  state: "command: rm -rf /tmp/work",
  question: "Should this command be allowed?",
  choices: ["allow", "deny"],
}

const KEYED_ENV = { BANYANCODE_JEV_API_KEY: "test-jev-key" }

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

describe("Jev.decide", () => {
  test("posts a bounded Choice question and validates the answer", async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      captured.url = url
      captured.init = init
      return jsonResponse({
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "choice",
            choice: "allow",
            probabilities: { allow: 0.9, deny: 0.1 },
            confidence: 0.87,
          },
        },
        usage: { input_tokens: 120, output_tokens: 20 },
      })
    }

    const result = await Jev.decide({
      ...INPUT,
      criteria: { allow: "explicitly safe", deny: null },
      env: KEYED_ENV,
      fetch: fakeFetch,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.choice).toBe("allow")
    expect(result.confidence).toBe(0.87)
    expect(result.probabilities).toEqual({ allow: 0.9, deny: 0.1 })
    expect(result.backend).toBe("typesafe")
    expect(result.model).toBe("jev-1.13.0")
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 20 })

    expect(captured.url).toBe("https://api.typesafe.ai/v1/systemone")
    const headers = new Headers(captured.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer test-jev-key")
    const body = JSON.parse(String(captured.init?.body))
    expect(body.model).toBe("jev-latest")
    expect(body.state).toBe(INPUT.state)
    expect(body.questions.decision).toEqual({
      type: "choice",
      instructions: INPUT.question,
      criteria: { allow: "explicitly safe", deny: null },
    })
  })

  test("explicit banyancode_jev_enabled=false disables the client even with a key", async () => {
    let calls = 0
    const fakeFetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const config = Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_enabled: false })
    const result = await Jev.decide({ ...INPUT, config, env: KEYED_ENV, fetch: fakeFetch })
    expect(result).toMatchObject({ ok: false, reason: "disabled" })
    expect(calls).toBe(0)
  })

  test("missing key fails safe as missing-key and never fetches", async () => {
    let calls = 0
    const fakeFetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const result = await Jev.decide({ ...INPUT, env: {}, fetch: fakeFetch })
    expect(result).toMatchObject({ ok: false, reason: "missing-key" })
    expect(calls).toBe(0)
  })

  test("config selects the openrouter backend: endpoint, model, and key follow it", async () => {
    const captured: { url?: string; init?: RequestInit } = {}
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      captured.url = url
      captured.init = init
      return jsonResponse({ answers: { decision: { type: "choice", choice: "deny", probabilities: { allow: 0.2, deny: 0.8 }, confidence: 0.8 } } })
    }
    const config = Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_backend: "openrouter", banyancode_jev_enabled: true })
    const result = await Jev.decide({
      ...INPUT,
      config,
      env: { BANYANCODE_JEV_API_KEY: "or-key" },
      fetch: fakeFetch,
    })
    expect(result.ok).toBe(true)
    expect(captured.url).toBe("https://openrouter.ai/api/v1/systemone")
    expect(new Headers(captured.init?.headers).get("authorization")).toBe("Bearer or-key")
    expect(JSON.parse(String(captured.init?.body)).model).toBe("typesafe/jev-latest")
    expect(Jev.ENDPOINTS.vercel).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone")
  })

  test("answers outside the bounded choice set fail closed as invalid-answer", async () => {
    const answerWith = (payload: unknown) => (async (): Promise<Response> => jsonResponse(payload))

    const foreign = await Jev.decide({
      ...INPUT,
      env: KEYED_ENV,
      fetch: answerWith({ answers: { decision: { type: "choice", choice: "escalate", confidence: 0.99 } } }),
    })
    expect(foreign).toMatchObject({ ok: false, reason: "invalid-answer" })
    if (foreign.ok) throw new Error("expected invalid-answer")
    expect(foreign.message).toContain("not one of the requested choices")

    const wrongType = await Jev.decide({
      ...INPUT,
      env: KEYED_ENV,
      fetch: answerWith({ answers: { decision: { type: "noul", noul: 0.9 } } }),
    })
    expect(wrongType).toMatchObject({ ok: false, reason: "invalid-answer" })

    const malformed = await Jev.decide({
      ...INPUT,
      env: KEYED_ENV,
      fetch: answerWith({ answers: { decision: { type: "choice", choice: "deny", probabilities: { deny: "0.7" } } } }),
    })
    expect(malformed).toMatchObject({ ok: false, reason: "invalid-answer" })
  })

  test("uses reported confidence rather than treating top probability as confidence", async () => {
    const fakeFetch = async (): Promise<Response> =>
      jsonResponse({
        answers: { decision: { type: "choice", choice: "deny", probabilities: { allow: 0.25, deny: 0.75 }, confidence: 0.7 } },
      })
    const result = await Jev.decide({ ...INPUT, env: KEYED_ENV, fetch: fakeFetch })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.confidence).toBe(0.7)
  })

  test("bounded choice validation runs before any network call", async () => {
    let calls = 0
    const fakeFetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const invalid: Jev.DecideInput[] = [
      { ...INPUT, choices: ["only-one"] },
      { ...INPUT, choices: ["allow", "allow"] },
      { ...INPUT, choices: ["", "deny"] },
      { ...INPUT, state: " " },
      { ...INPUT, choices: Array.from({ length: 256 }, (_, index) => `c${index}`) },
      { ...INPUT, state: "x".repeat(120_001) },
      { ...INPUT, question: "x".repeat(8_001) },
      { ...INPUT, criteria: { allow: "x".repeat(2_001) } },
      { ...INPUT, timeoutMs: 0 },
      { ...INPUT, timeoutMs: 10_001 },
    ]
    for (const input of invalid) {
      const result = await Jev.decide({ ...input, env: KEYED_ENV, fetch: fakeFetch })
      expect(result).toMatchObject({ ok: false, reason: "invalid-input" })
    }
    expect(calls).toBe(0)
    expect(await Jev.decide({ ...INPUT, env: KEYED_ENV, endpoint: "https://attacker.example/v1/systemone" }))
      .toMatchObject({ ok: false, reason: "invalid-input" })
  })

  test("malformed runtime input does not reject", async () => {
    const result = await Jev.decide(null as unknown as Jev.DecideInput)
    expect(result).toMatchObject({ ok: false, reason: "invalid-input" })
  })

  test("HTTP errors surface as http-error with status and never throw", async () => {
    const fakeFetch = async (): Promise<Response> => new Response("Invalid API key", { status: 401 })
    const result = await Jev.decide({ ...INPUT, env: KEYED_ENV, fetch: fakeFetch })
    expect(result).toMatchObject({ ok: false, reason: "http-error", status: 401 })
    if (result.ok) throw new Error("expected http-error")
    expect(result.message).toContain("401")
    expect(result.message).not.toContain("Invalid API key")
  })

  test("network failures fail safe as network instead of rejecting", async () => {
    const failingFetch = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED")
    }
    const result = await Jev.decide({ ...INPUT, env: KEYED_ENV, fetch: failingFetch })
    expect(result).toMatchObject({ ok: false, reason: "network" })
  })

  test("does not activate Jev from generic gateway credentials alone", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls++
      return jsonResponse({})
    }
    const result = await Jev.decide({
      ...INPUT,
      config: { banyancode_jev_backend: "openrouter" },
      env: { OPENROUTER_API_KEY: "existing-unrelated-key" },
      fetch,
    })
    expect(result).toMatchObject({ ok: false, reason: "missing-key" })
    expect(calls).toBe(0)
  })

  test("rejects malformed probability distributions before applying a decision", async () => {
    const malformed = [
      { allow: 1.2, deny: -0.2 },
      { allow: 0.2, deny: 0.2 },
      { allow: 0.7, deny: 0.3, unknown: 0 },
      { allow: 0.9, deny: 0.1 },
    ]
    for (const probabilities of malformed) {
      const result = await Jev.decide({
        ...INPUT,
        env: KEYED_ENV,
        fetch: async () => jsonResponse({
          answers: { decision: { type: "choice", choice: "deny", confidence: 0.9, probabilities } },
        }),
      })
      expect(result).toMatchObject({ ok: false, reason: "invalid-answer" })
    }
  })

  test("a slow endpoint aborts at timeoutMs and reports timeout", async () => {
    const hangingFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))
      })
    const result = await Jev.decide({ ...INPUT, env: KEYED_ENV, timeoutMs: 15, fetch: hangingFetch })
    expect(result).toMatchObject({ ok: false, reason: "timeout" })
  })
})

describe("Jev enablement", () => {
  test("key presence enables by default; explicit config wins", () => {
    expect(Jev.isEnabled({}, { BANYANCODE_JEV_API_KEY: "k" })).toBe(true)
    expect(Jev.isEnabled({}, {})).toBe(false)
    expect(Jev.isEnabled({ banyancode_jev_enabled: false }, { BANYANCODE_JEV_API_KEY: "k" })).toBe(false)
    expect(Jev.isEnabled({ banyancode_jev_enabled: true }, {})).toBe(false)
    expect(Jev.resolve({}, { TYPESAFE_API_KEY: "ts-key" }).apiKey).toBe("ts-key")
    expect(Jev.resolve({ banyancode_jev_backend: "vercel" }, { AI_GATEWAY_API_KEY: "vg" })).toMatchObject({
      enabled: false,
      backend: "vercel",
      model: "typesafe-ai/jev",
      apiKey: undefined,
    })
    expect(Jev.resolve({ banyancode_jev_backend: "vercel", banyancode_jev_enabled: true }, { BANYANCODE_JEV_API_KEY: "vg" }).enabled).toBe(true)
  })
})

describe("BanyanConfig jev fields", () => {
  test("decodes enabled/backend/model and rejects unknown backends", () => {
    const parsed = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_enabled: true,
      banyancode_jev_backend: "openrouter",
      banyancode_jev_model: "typesafe/jev-1.13",
    })
    expect(parsed.banyancode_jev_enabled).toBe(true)
    expect(parsed.banyancode_jev_backend).toBe("openrouter")
    expect(parsed.banyancode_jev_model).toBe("typesafe/jev-1.13")
    expect(Schema.decodeSync(BanyanConfig.Info)({}).banyancode_jev_enabled).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(BanyanConfig.Info)({ banyancode_jev_backend: "bogus" })).toThrow()
  })
})
