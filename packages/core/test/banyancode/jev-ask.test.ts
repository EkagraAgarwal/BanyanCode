import { beforeEach, describe, expect, test } from "bun:test"
import { Jev } from "../../src/banyancode/jev"

const KEYED_ENV = { BANYANCODE_JEV_API_KEY: "test-jev-key" }

const jsonResponse = (payload: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } })

const choiceAnswer = (id: string, choice: string, probabilities: Record<string, number>, confidence: number) => ({
  model: "jev-1.13.0",
  answers: { [id]: { type: "choice", choice, probabilities, confidence } },
})

const askInput = (overrides?: Partial<Jev.AskInput>): Jev.AskInput => ({
  state: "ask-test state",
  questions: {
    q1: { type: "choice", instructions: "Pick one.", criteria: { a: "first", b: null } },
  },
  env: KEYED_ENV,
  ...overrides,
})

beforeEach(() => {
  Jev.resetJevStateForTests()
})

describe("Jev.ask validators", () => {
  test("rejects empty and oversized question maps before any network call", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const empty = await Jev.ask({ state: "s", questions: {}, env: KEYED_ENV, fetch })
    expect(empty).toMatchObject({ ok: false, reason: "invalid-input" })
    const tooMany = await Jev.ask({
      state: "s",
      questions: Object.fromEntries(
        Array.from({ length: 26 }, (_, index) => [`q${index}`, { type: "noul", instructions: "Is it?" }]),
      ),
      env: KEYED_ENV,
      fetch,
    })
    expect(tooMany).toMatchObject({ ok: false, reason: "invalid-input" })
    expect(calls).toBe(0)
  })

  test("rejects unknown question types and malformed per-type criteria", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const cases: Array<Record<string, Jev.Question>> = [
      { q: { type: "mystery", instructions: "x" } as unknown as Jev.Question },
      { q: { type: "noul", instructions: " " } },
      { q: { type: "noul", instructions: "Is it?", criteria: { maybe: "x" } } as unknown as Jev.Question },
      { q: { type: "choice", instructions: "Pick.", criteria: { only: "one" } } },
      { q: { type: "choice", instructions: "Pick.", criteria: { a: "x".repeat(2001), b: null } } },
      { q: { type: "score", instructions: "Rate.", criteria: ["only-one"] } },
      { q: { type: "score", instructions: "Rate.", criteria: Array.from({ length: 11 }, (_, i) => `c${i}`) } },
      { q: { type: "score", instructions: "Rate.", criteria: ["x", "x"] } },
      { "": { type: "noul", instructions: "Is it?" } },
    ]
    for (const questions of cases) {
      const result = await Jev.ask({ state: "s", questions, env: KEYED_ENV, fetch })
      expect(result).toMatchObject({ ok: false, reason: "invalid-input" })
    }
    expect(calls).toBe(0)
  })

  test("rejects secret-looking choice labels and question ids", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const secretLabel = await Jev.ask({
      state: "s",
      questions: {
        q1: { type: "choice", instructions: "Pick.", criteria: { "sk-sensitiveLabel123456": "k", b: null } },
      },
      env: KEYED_ENV,
      fetch,
    })
    expect(secretLabel).toMatchObject({ ok: false, reason: "invalid-input" })
    const secretId = await Jev.ask({
      state: "s",
      questions: { "password=hiddenCredential": { type: "noul", instructions: "Set?" } },
      env: KEYED_ENV,
      fetch,
    })
    expect(secretId).toMatchObject({ ok: false, reason: "invalid-input" })
    const decideSecret = await Jev.decide({
      state: "s",
      question: "Allow?",
      choices: ["allow", "Bearer sensitiveCredential123"],
      env: KEYED_ENV,
      fetch,
    })
    expect(decideSecret).toMatchObject({ ok: false, reason: "invalid-input" })
    expect(calls).toBe(0)
  })

  test("redacts quoted JSON secrets without rejecting neutral category names", async () => {
    const seen: string[] = []
    const result = await Jev.ask({
      state: JSON.stringify({ password: "secret with spaces", api_key: "privateCredentialValue" }),
      questions: {
        password: {
          type: "choice",
          instructions: "Which credential category is mentioned?",
          criteria: { password: "A password", api_key: "An API key" },
        },
      },
      env: KEYED_ENV,
      fetch: async (_url, init) => {
        seen.push(String(init?.body))
        return jsonResponse(choiceAnswer("password", "password", { password: 0.9, api_key: 0.1 }, 0.8))
      },
    })
    expect(result.ok).toBe(true)
    expect(seen[0]).not.toContain("secret with spaces")
    expect(seen[0]).not.toContain("privateCredentialValue")
    expect(seen[0]).toContain("[redacted]")
  })

  test("rejects malformed runtime input and bad timeout/endpoint combos", async () => {
    expect(await Jev.ask(null as unknown as Jev.AskInput)).toMatchObject({ ok: false, reason: "invalid-input" })
    expect(
      await Jev.ask({ state: " ", questions: { q: { type: "noul", instructions: "x" } }, env: KEYED_ENV }),
    ).toMatchObject({ ok: false, reason: "invalid-input" })
    expect(
      await Jev.ask({
        state: "s",
        questions: { q: { type: "noul", instructions: "x" } },
        env: KEYED_ENV,
        timeoutMs: 0,
      }),
    ).toMatchObject({ ok: false, reason: "invalid-input" })
    expect(
      await Jev.ask({
        state: "s",
        questions: { q: { type: "noul", instructions: "x" } },
        env: KEYED_ENV,
        endpoint: "https://attacker.example/v1/systemone",
      }),
    ).toMatchObject({ ok: false, reason: "invalid-input" })
  })

  test("malformed connection options return errors rather than rejecting", async () => {
    for (const options of [{ backend: "unknown" }, { apiKey: 123 }, { model: 123 }, { fetch: 123 }, { signal: null }]) {
      expect(await Jev.ask({ ...askInput(), ...options } as unknown as Jev.AskInput)).toMatchObject({
        ok: false,
        reason: "invalid-input",
      })
    }
  })

  test("rejects payloads over the local token bounds", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const huge = await Jev.ask({
      state: `payload-state ${"a".repeat(100_000)}`,
      questions: { q1: { type: "choice", instructions: "Pick.", criteria: { a: null, b: null } } },
      env: KEYED_ENV,
      fetch,
    })
    expect(huge).toMatchObject({ ok: false, reason: "invalid-input" })
    if (huge.ok) throw new Error("expected invalid-input")
    expect(huge.message).toContain("32000")
    const wide = await Jev.ask({
      state: "s",
      questions: Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [
          `q${index}`,
          { type: "choice", instructions: `Pick ${index}. ${"b".repeat(7900)}`, criteria: { a: null, b: null } },
        ]),
      ),
      env: KEYED_ENV,
      fetch,
    })
    expect(wide).toMatchObject({ ok: false, reason: "invalid-input" })
    if (wide.ok) throw new Error("expected invalid-input")
    expect(wide.message).toContain("64000")
    expect(calls).toBe(0)
  })

  test("disabled and missing-key fail before budgets or network", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const disabled = await Jev.ask({
      ...askInput({ fetch }),
      config: { banyancode_jev_enabled: false, banyancode_jev_budget: { perTurnCalls: 1 } },
    })
    expect(disabled).toMatchObject({ ok: false, reason: "disabled" })
    const missing = await Jev.ask({ state: "s", questions: { q: { type: "noul", instructions: "x" } }, env: {}, fetch })
    expect(missing).toMatchObject({ ok: false, reason: "missing-key" })
    expect(calls).toBe(0)
    expect(Jev.usage("default")).toMatchObject({ requests: 0, cachedHits: 0 })
  })
})

describe("Jev.ask wire format", () => {
  test("posts all three primitives and parses discriminated answers", async () => {
    const captured: { body?: unknown } = {}
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      captured.body = JSON.parse(String(init?.body))
      return jsonResponse({
        model: "jev-1.13.0",
        answers: {
          pick: { type: "choice", choice: "b", probabilities: { a: 0.3, b: 0.7 }, confidence: 0.65 },
          flag: { type: "noul", noul: 0.9 },
          grade: {
            type: "score",
            score: 0.8,
            legend: { "0": "bad", "1": "good" },
            probabilities: { "0": 0.2, "1": 0.8 },
            confidence: 0.75,
          },
        },
        usage: { input_tokens: 50, output_tokens: 5, cost: 0.001 },
      })
    }
    const result = await Jev.ask({
      state: "shared facts",
      questions: {
        pick: { type: "choice", instructions: "Pick one.", criteria: { a: null, b: "second" } },
        flag: { type: "noul", instructions: "Is it set?", criteria: { true: "set", false: "unset" } },
        grade: { type: "score", instructions: "Rate it.", criteria: ["bad", "good"] },
      },
      env: KEYED_ENV,
      fetch,
      sessionID: "wire-1",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.answers.pick).toMatchObject({ type: "choice", choice: "b", confidence: 0.65 })
    expect(result.answers.flag).toEqual({ type: "noul", noul: 0.9 })
    expect(result.answers.grade).toMatchObject({ type: "score", score: 0.8, confidence: 0.75 })
    expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 5, cost: 0.001 })
    expect(result.cached).toBe(false)
    const body = captured.body as { state: string; model: string; questions: Record<string, { type: string }> }
    expect(body.state).toBe("shared facts")
    expect(body.model).toBe("jev-latest")
    expect(Object.keys(body.questions).sort()).toEqual(["flag", "grade", "pick"])
  })

  test("accepts noul probabilities 0, 0.42, 1 and rejects the rest", async () => {
    for (const noul of [0, 0.42, 1]) {
      const result = await Jev.ask({
        state: `noul-${noul}`,
        questions: { n: { type: "noul", instructions: "Set?" } },
        env: KEYED_ENV,
        fetch: async () => jsonResponse({ answers: { n: { type: "noul", noul } } }),
        sessionID: "noul-ok",
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.answers.n).toEqual({ type: "noul", noul })
    }
    for (const [label, noul] of [
      ["bool", true],
      ["negative", -0.1],
      ["above", 1.5],
      ["text", "0.5"],
    ] as const) {
      const result = await Jev.ask({
        state: `noul-bad-${label}`,
        questions: { n: { type: "noul", instructions: "Set?" } },
        env: KEYED_ENV,
        fetch: async () => jsonResponse({ answers: { n: { type: "noul", noul } } }),
        sessionID: "noul-bad",
      })
      expect(result).toMatchObject({ ok: false, reason: "invalid-answer" })
    }
  })

  test("bounds score values and legends", async () => {
    const withScore = (answer: unknown) => async (): Promise<Response> => jsonResponse({ answers: { g: answer } })
    const base = {
      state: "score-bounds",
      questions: { g: { type: "score", instructions: "Rate.", criteria: ["bad", "good"] } },
      env: KEYED_ENV,
    } as const
    const good = {
      type: "score",
      score: 0.8,
      legend: { "0": "bad", "1": "good" },
      probabilities: { "0": 0.2, "1": 0.8 },
      confidence: 0.7,
    }
    expect((await Jev.ask({ ...base, state: "score-ok", fetch: withScore(good), sessionID: "score-1" })).ok).toBe(true)
    for (const [label, answer] of [
      ["high", { ...good, score: 1.2 }],
      ["bool", { ...good, score: true }],
      ["legend-missing", { ...good, legend: undefined }],
      ["probabilities-labels", { ...good, probabilities: { bad: 0.2, good: 0.8 } }],
      ["legend-number", { ...good, legend: { good: 5 } }],
      ["legend-long", { ...good, legend: { good: "x".repeat(2001) } }],
      ["legend-many", { ...good, legend: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])) }],
    ] as const) {
      const result = await Jev.ask({
        ...base,
        state: `score-bad-${label}`,
        fetch: withScore(answer),
        sessionID: "score-2",
      })
      expect(result).toMatchObject({ ok: false, reason: "invalid-answer" })
    }
  })

  test("accepts the documented multi-level Score response above one", async () => {
    const result = await Jev.ask({
      state: "The customer is frustrated but not very angry.",
      questions: {
        frustration: {
          type: "score",
          instructions: "How frustrated is the customer?",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
      },
      env: KEYED_ENV,
      fetch: async () =>
        jsonResponse({
          model: "jev-1.13.0",
          answers: {
            frustration: {
              type: "score",
              score: 1.05,
              legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
              probabilities: { "0": 0, "1": 0.95, "2": 0.05 },
              confidence: 0.92,
            },
          },
          usage: { input_tokens: 304, output_tokens: 18 },
        }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.answers.frustration).toMatchObject({ type: "score", score: 1.05, confidence: 0.92 })
  })

  test("redacts secrets in state, instructions, and criteria before sending", async () => {
    const captured: { body?: unknown } = {}
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      captured.body = JSON.parse(String(init?.body))
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const secretState = "deploy with api_key=sk-abc123XYZ789 and password: hunter2secret plus Bearer abcdefgh12345678"
    const result = await Jev.ask(
      askInput({
        state: secretState,
        questions: {
          q1: {
            type: "choice",
            instructions: "Approve token=supersecretvalue now?",
            criteria: { a: "api_key=hunter2value", b: null },
          },
        },
        fetch,
        sessionID: "redact-1",
      }),
    )
    expect(result.ok).toBe(true)
    const body = captured.body as {
      state: string
      questions: { q1: { instructions: string; criteria: Record<string, string | null> } }
    }
    expect(body.state).not.toContain("sk-abc123XYZ789")
    expect(body.state).not.toContain("hunter2secret")
    expect(body.state).not.toContain("abcdefgh12345678")
    expect(body.state).toContain("[redacted]")
    expect(body.questions.q1.instructions).not.toContain("supersecretvalue")
    expect(body.questions.q1.criteria.a).not.toContain("hunter2value")
    expect(body.questions.q1.criteria.a).toContain("[redacted]")
  })

  test("invalid server answers fail closed per question", async () => {
    const withPayload = (payload: unknown) => async (): Promise<Response> => jsonResponse(payload)
    const wrongType = await Jev.ask(
      askInput({ fetch: withPayload({ answers: { q1: { type: "noul", noul: 0.8 } } }), sessionID: "inv-1" }),
    )
    expect(wrongType).toMatchObject({ ok: false, reason: "invalid-answer" })
    const foreign = await Jev.ask(
      askInput({
        fetch: withPayload({
          answers: { q1: { type: "choice", choice: "zzz", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 } },
        }),
        sessionID: "inv-2",
      }),
    )
    expect(foreign).toMatchObject({ ok: false, reason: "invalid-answer" })
    if (foreign.ok) throw new Error("expected invalid-answer")
    expect(foreign.message).toContain("not one of the requested choices")
    for (const [label, noul] of [
      ["text", "yes"],
      ["bool", true],
    ] as const) {
      const badNoul = await Jev.ask({
        state: `s-${label}`,
        questions: { n: { type: "noul", instructions: "Set?" } },
        env: KEYED_ENV,
        fetch: withPayload({ answers: { n: { type: "noul", noul } } }),
        sessionID: "inv-3",
      })
      expect(badNoul).toMatchObject({ ok: false, reason: "invalid-answer" })
    }
  })
})

describe("Jev.ask cache and single-flight", () => {
  test("prototype-like question ids remain part of the cache key", async () => {
    let calls = 0
    const fetch = async (_url: string, init?: RequestInit) => {
      calls += 1
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, Jev.ChoiceQuestion> }
      const choice = Object.keys(body.questions.__proto__.criteria)[0]
      return jsonResponse(choiceAnswer("__proto__", choice, { [choice]: 0.9, other: 0.1 }, 0.8))
    }
    const input = (choice: string): Jev.AskInput =>
      askInput({
        fetch,
        questions: Object.fromEntries([
          [
            "__proto__",
            {
              type: "choice",
              instructions: "Select the candidate.",
              criteria: { [choice]: null, other: null },
            },
          ],
        ]),
      })
    const first = await Jev.ask(input("first"))
    const second = await Jev.ask(input("second"))
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.answers.__proto__).toMatchObject({ type: "choice", choice: "second" })
    expect(calls).toBe(2)
  })
  test("identical asks hit the bounded cache without a second request", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const first = await Jev.ask(askInput({ fetch, sessionID: "cache-1" }))
    expect(first.ok).toBe(true)
    const second = await Jev.ask(askInput({ fetch, sessionID: "cache-1" }))
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error(second.message)
    expect(second.cached).toBe(true)
    expect(calls).toBe(1)
    expect(Jev.usage("cache-1")).toMatchObject({ requests: 1, cachedHits: 1 })
  })

  test("cache keys isolate auth identity, fetch, session, and deadline config", async () => {
    const success = () => jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    let calls = 0
    const counting = (fetch: () => Promise<Response>) => async (): Promise<Response> => {
      calls += 1
      return fetch()
    }
    const fetchA = counting(async () => success())
    const first = await Jev.ask(
      askInput({ state: "identity", fetch: fetchA, sessionID: "key-1", env: { BANYANCODE_JEV_API_KEY: "key-a" } }),
    )
    expect(first.ok).toBe(true)
    const otherKey = await Jev.ask(
      askInput({ state: "identity", fetch: fetchA, sessionID: "key-1", env: { BANYANCODE_JEV_API_KEY: "key-b" } }),
    )
    expect(otherKey.ok).toBe(true)
    if (otherKey.ok) expect(otherKey.cached).not.toBe(true)
    const fetchB = counting(async () => success())
    const otherFetch = await Jev.ask(
      askInput({ state: "identity", fetch: fetchB, sessionID: "key-1", env: { BANYANCODE_JEV_API_KEY: "key-a" } }),
    )
    expect(otherFetch.ok).toBe(true)
    if (otherFetch.ok) expect(otherFetch.cached).not.toBe(true)
    const otherSession = await Jev.ask(
      askInput({ state: "identity", fetch: fetchA, sessionID: "key-2", env: { BANYANCODE_JEV_API_KEY: "key-a" } }),
    )
    expect(otherSession.ok).toBe(true)
    if (otherSession.ok) expect(otherSession.cached).not.toBe(true)
    const otherDeadline = await Jev.ask(
      askInput({
        state: "identity",
        fetch: fetchA,
        sessionID: "key-1",
        timeoutMs: 999,
        env: { BANYANCODE_JEV_API_KEY: "key-a" },
      }),
    )
    expect(otherDeadline.ok).toBe(true)
    if (otherDeadline.ok) expect(otherDeadline.cached).not.toBe(true)
    expect(calls).toBe(5)
  })

  test("different states isolate cache entries", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    await Jev.ask(askInput({ state: "state-one", fetch, sessionID: "cache-2" }))
    await Jev.ask(askInput({ state: "state-two", fetch, sessionID: "cache-2" }))
    expect(calls).toBe(2)
  })

  test("concurrent identical asks share one physical request", async () => {
    let calls = 0
    let releaseFetch!: (value: Response) => void
    const gate = new Promise<Response>((resolveGate) => {
      releaseFetch = resolveGate
    })
    const fetch = (): Promise<Response> => {
      calls += 1
      return gate
    }
    const one = Jev.ask(askInput({ fetch, sessionID: "dedup-1" }))
    const two = Jev.ask(askInput({ fetch, sessionID: "dedup-1" }))
    await Bun.sleep(10)
    releaseFetch(jsonResponse(choiceAnswer("q1", "b", { a: 0.2, b: 0.8 }, 0.7)))
    const [first, second] = await Promise.all([one, two])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second).toMatchObject({ cached: true, usage: { inputTokens: 0, outputTokens: 0, cost: 0 } })
    expect(calls).toBe(1)
    expect(Jev.usage("dedup-1")).toMatchObject({ requests: 1 })
  })

  test("cancelling one joiner does not disturb the shared request", async () => {
    let calls = 0
    const signals: Array<AbortSignal | undefined> = []
    let releaseFetch!: (value: Response) => void
    const gate = new Promise<Response>((resolveGate) => {
      releaseFetch = resolveGate
    })
    const fetch = (_url: string, init?: RequestInit): Promise<Response> => {
      calls += 1
      signals.push(init?.signal ?? undefined)
      return gate
    }
    const controller = new AbortController()
    const one = Jev.ask(askInput({ fetch, signal: controller.signal, sessionID: "dedup-2" }))
    const two = Jev.ask(askInput({ fetch, sessionID: "dedup-2" }))
    await Bun.sleep(10)
    controller.abort()
    const cancelled = await one
    expect(cancelled).toMatchObject({ ok: false, reason: "cancelled" })
    releaseFetch(jsonResponse(choiceAnswer("q1", "a", { a: 0.95, b: 0.05 }, 0.9)))
    const survivor = await two
    expect(survivor.ok).toBe(true)
    expect(calls).toBe(1)
    expect(signals.every((signal) => !signal?.aborted)).toBe(true)
  })

  test("cancelling the sole caller aborts the physical request", async () => {
    let aborted = false
    const fetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("cancelled", "AbortError"))
        })
      })
    const controller = new AbortController()
    const pending = Jev.ask(askInput({ fetch, signal: controller.signal, sessionID: "abort-phys", timeoutMs: 5000 }))
    await Bun.sleep(10)
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, reason: "cancelled" })
    expect(aborted).toBe(true)
  })
})

describe("Jev.ask abort, deadline, and retries", () => {
  test("pre-aborted signal cancels without a request", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({})
    }
    const controller = new AbortController()
    controller.abort()
    const result = await Jev.ask(askInput({ fetch, signal: controller.signal, sessionID: "abort-1" }))
    expect(result).toMatchObject({ ok: false, reason: "cancelled" })
    expect(calls).toBe(0)
  })

  test("a slow endpoint aborts at timeoutMs and reports timeout", async () => {
    const hanging = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))
      })
    const result = await Jev.ask(askInput({ fetch: hanging, timeoutMs: 20, sessionID: "abort-2" }))
    expect(result).toMatchObject({ ok: false, reason: "timeout" })
  })

  test("a hanging body keeps the deadline and releases the permit", async () => {
    const response = jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    Object.defineProperty(response, "json", { value: () => new Promise<unknown>(() => {}) })
    const hangingBody = async (): Promise<Response> => response
    const config: Jev.Config = { banyancode_jev_client: { maxInflight: 1 } }
    const timedOut = await Jev.ask(askInput({ fetch: hangingBody, timeoutMs: 30, sessionID: "body-1", config }))
    expect(timedOut).toMatchObject({ ok: false, reason: "timeout" })
    const fetch = async (): Promise<Response> => jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    const next = await Jev.ask(askInput({ state: "after-hang", fetch, sessionID: "body-1", config }))
    expect(next.ok).toBe(true)
  })

  test("a hanging retry body is bounded and releases the sole permit", async () => {
    const response = new Response("overloaded", { status: 429, headers: { "retry-after": "0" } })
    Object.defineProperty(response, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(() => {}) })
    const config: Jev.Config = { banyancode_jev_client: { maxInflight: 1 } }
    const timedOut = await Jev.ask(
      askInput({ fetch: async () => response, timeoutMs: 25, sessionID: "body-retry", config }),
    )
    expect(timedOut).toMatchObject({ ok: false, reason: "timeout" })
    const next = await Jev.ask(
      askInput({
        state: "after-error-body",
        fetch: async () => jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8)),
        config,
      }),
    )
    expect(next.ok).toBe(true)
  })

  test("invalid JSON fails without a retry", async () => {
    let calls = 0
    const result = await Jev.ask(
      askInput({
        fetch: async () => {
          calls += 1
          return new Response("not JSON")
        },
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: "invalid-answer" })
    expect(calls).toBe(1)
  })

  test("free cached answers remain available after the USD budget is exhausted", async () => {
    const fetch = async () =>
      jsonResponse({
        ...choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8),
        usage: { cost: 2, input_tokens: 10, output_tokens: 1 },
      })
    const input = askInput({ fetch, config: { banyancode_jev_budget: { perSessionUsd: 1 } } })
    expect((await Jev.ask(input)).ok).toBe(true)
    const cached = await Jev.ask(input)
    expect(cached).toMatchObject({ ok: true, cached: true, usage: { inputTokens: 0, outputTokens: 0, cost: 0 } })
    expect(Jev.usage("default").requests).toBe(1)
  })

  test("429 with Retry-After retries once and succeeds", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const result = await Jev.ask(askInput({ fetch, sessionID: "retry-1" }))
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    expect(Jev.usage("retry-1")).toMatchObject({ requests: 2 })
  })

  test("Retry-After beyond the deadline returns timeout without another request", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return new Response("slow down", { status: 429, headers: { "retry-after": "30" } })
    }
    const result = await Jev.ask(askInput({ fetch, timeoutMs: 200, sessionID: "retry-after" }))
    expect(result).toMatchObject({ ok: false, reason: "timeout" })
    expect(calls).toBe(1)
  })

  test("non-retryable HTTP errors do not retry", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return new Response("bad request", { status: 400 })
    }
    const result = await Jev.ask(
      askInput({ fetch, sessionID: "retry-2", config: { banyancode_jev_client: { retries: 3 } } }),
    )
    expect(result).toMatchObject({ ok: false, reason: "http-error", status: 400 })
    expect(calls).toBe(1)
  })

  test("network failure retries then succeeds within the retry budget", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      if (calls === 1) throw new Error("ECONNREFUSED")
      return jsonResponse(choiceAnswer("q1", "b", { a: 0.2, b: 0.8 }, 0.7))
    }
    const result = await Jev.ask(askInput({ fetch, sessionID: "retry-3" }))
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    expect(Jev.usage("retry-3")).toMatchObject({ requests: 2 })
  })

  test("rate budgets cover each retry, not just the logical call", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return new Response("busy", { status: 503 })
    }
    const result = await Jev.ask(
      askInput({
        fetch,
        sessionID: "retry-rate",
        config: { banyancode_jev_client: { requestsPerMinute: 2, retries: 2 } },
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: "rate-limited" })
    expect(calls).toBe(2)
  })
})

describe("Jev.ask budgets", () => {
  test("perTurnCalls caps logical calls per scope", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const config: Jev.Config = { banyancode_jev_budget: { perTurnCalls: 1 } }
    const first = await Jev.ask(askInput({ state: "turn-a", fetch, config, sessionID: "budget-1", scope: "turn" }))
    expect(first.ok).toBe(true)
    const second = await Jev.ask(askInput({ state: "turn-b", fetch, config, sessionID: "budget-1", scope: "turn" }))
    expect(second).toMatchObject({ ok: false, reason: "budget-exceeded" })
    expect(calls).toBe(1)
  })

  test("perSessionUsd caps accumulated reported cost", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse({
        model: "jev-1.13.0",
        answers: { q1: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 } },
        usage: { input_tokens: 10, output_tokens: 2, cost: 2 },
      })
    }
    const config: Jev.Config = { banyancode_jev_budget: { perSessionUsd: 1 } }
    const first = await Jev.ask(askInput({ state: "usd-a", fetch, config, sessionID: "budget-2" }))
    expect(first.ok).toBe(true)
    const second = await Jev.ask(askInput({ state: "usd-b", fetch, config, sessionID: "budget-2" }))
    expect(second).toMatchObject({ ok: false, reason: "budget-exceeded" })
    expect(calls).toBe(1)
  })

  test("perSessionUsd fail-safes on unknown model pricing", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const config: Jev.Config = {
      banyancode_jev_backend: "openrouter",
      banyancode_jev_budget: { perSessionUsd: 100 },
    }
    const result = await Jev.ask(askInput({ fetch, config, sessionID: "budget-unknown" }))
    expect(result).toMatchObject({ ok: false, reason: "budget-exceeded" })
    expect(calls).toBe(0)
  })

  test("estimated cost is reserved atomically across concurrent calls", async () => {
    const questions = { q1: { type: "choice", instructions: "Pick.", criteria: { a: null, b: null } } } as const
    const est = Jev.estimateTokens("cost-state-aaaa", questions)
    expect(Jev.estimateTokens("cost-state-bbbb", questions)).toBe(est)
    const single = (est * Jev.JEV_USD_PER_MTOKEN) / 1_000_000
    expect(single).toBeGreaterThan(0)
    const config: Jev.Config = { banyancode_jev_budget: { perSessionUsd: single * 1.5 } }
    let calls = 0
    let releaseFetch!: (value: Response) => void
    const gate = new Promise<Response>((resolveGate) => {
      releaseFetch = resolveGate
    })
    const fetch = (): Promise<Response> => {
      calls += 1
      return gate
    }
    const one = Jev.ask(
      askInput({ state: "cost-state-aaaa", fetch, config, sessionID: "budget-atomic", questions: { ...questions } }),
    )
    const two = Jev.ask(
      askInput({ state: "cost-state-bbbb", fetch, config, sessionID: "budget-atomic", questions: { ...questions } }),
    )
    await Bun.sleep(10)
    const pending = await Promise.race([
      Promise.all([one, two]).then(() => "done" as const),
      Bun.sleep(50).then(() => "waiting" as const),
    ])
    expect(pending).toBe("waiting")
    releaseFetch(jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8)))
    const [first, second] = await Promise.all([one, two])
    const reasons = [first, second].map((result) => (result.ok ? "ok" : result.reason)).sort()
    expect(reasons).toEqual(["budget-exceeded", "ok"])
    expect(calls).toBe(1)
    expect(Jev.usage("budget-atomic").estimatedCost).toBeCloseTo(single, 12)
  })

  test("requestsPerMinute rejects overflow without a request", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const config: Jev.Config = { banyancode_jev_client: { requestsPerMinute: 1, retries: 0 } }
    const first = await Jev.ask(askInput({ state: "rpm-a", fetch, config, sessionID: "budget-3" }))
    expect(first.ok).toBe(true)
    const second = await Jev.ask(askInput({ state: "rpm-b", fetch, config, sessionID: "budget-3" }))
    expect(second).toMatchObject({ ok: false, reason: "rate-limited" })
    expect(calls).toBe(1)
  })

  test("rate windows hold full history at scale", async () => {
    const fetch = async (): Promise<Response> => jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    const config: Jev.Config = { banyancode_jev_client: { requestsPerMinute: 1200, retries: 0 } }
    let limited = 0
    for (let index = 0; index < 1210; index += 1) {
      const result = await Jev.ask(askInput({ state: `scale-${index}`, fetch, config, sessionID: "scale-1" }))
      if (!result.ok) {
        expect(result.reason).toBe("rate-limited")
        limited += 1
      }
    }
    expect(limited).toBe(10)
    expect(Jev.usage("scale-1")).toMatchObject({ requests: 1200 })
  })

  test("concurrency saturation fails fast instead of hanging", async () => {
    let calls = 0
    let releaseFetch!: (value: Response) => void
    const gate = new Promise<Response>((resolveGate) => {
      releaseFetch = resolveGate
    })
    const fetch = (): Promise<Response> => {
      calls += 1
      return gate
    }
    const config: Jev.Config = { banyancode_jev_client: { maxInflight: 1, retries: 0 } }
    const one = Jev.ask(askInput({ state: "conc-a", fetch, config, sessionID: "conc-1" }))
    const two = Jev.ask(askInput({ state: "conc-b", fetch, config, sessionID: "conc-1" }))
    await Bun.sleep(10)
    releaseFetch(jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8)))
    const [first, second] = await Promise.all([one, two])
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, reason: "rate-limited" })
    if (!second.ok) expect(second.message).toContain("concurrency")
    expect(calls).toBe(1)
  })
})

describe("Jev.feature and Jev.usage", () => {
  test("judge keeps its connected behavior; explorer keeps its tree opt-in", () => {
    expect(Jev.feature({}, KEYED_ENV, "judge")).toBe(true)
    expect(Jev.feature({}, {}, "judge")).toBe(false)
    expect(Jev.feature({ banyancode_jev_enabled: false }, KEYED_ENV, "judge")).toBe(false)
    expect(Jev.feature({}, KEYED_ENV, "explorer")).toBe(false)
    expect(Jev.feature({ banyancode_jev_tree: { enabled: true } }, KEYED_ENV, "explorer")).toBe(true)
  })

  test("subagent-routing keeps its legacy alternates enablement", () => {
    const alternates: Jev.Config = {
      banyancode_jev_enabled: true,
      banyancode_jev_subagent_models: { fast: { model: "provider/fast-model" } },
    }
    expect(Jev.feature(alternates, KEYED_ENV, "subagent-routing")).toBe(true)
    expect(Jev.feature({ ...alternates, banyancode_jev_tree: { enabled: false } }, KEYED_ENV, "subagent-routing")).toBe(
      true,
    )
    expect(
      Jev.feature(
        { banyancode_jev_tree: { enabled: false }, banyancode_jev_features: { explorer: true } },
        KEYED_ENV,
        "explorer",
      ),
    ).toBe(false)
    expect(Jev.feature({ banyancode_jev_enabled: true }, KEYED_ENV, "subagent-routing")).toBe(false)
    expect(Jev.feature({}, KEYED_ENV, "subagent-routing")).toBe(false)
  })

  test("automatic features need aggressive profile or explicit opt-in", () => {
    expect(Jev.feature({}, KEYED_ENV, "turn-routing")).toBe(false)
    expect(Jev.feature({ banyancode_jev_profile: "aggressive" }, KEYED_ENV, "turn-routing")).toBe(true)
    expect(Jev.feature({ banyancode_jev_profile: "aggressive" }, KEYED_ENV, "unknown-future")).toBe(true)
    expect(Jev.feature({}, KEYED_ENV, "unknown-future")).toBe(false)
    expect(Jev.feature({ banyancode_jev_features: { "turn-routing": true } }, KEYED_ENV, "turn-routing")).toBe(true)
    expect(
      Jev.feature(
        { banyancode_jev_profile: "aggressive", banyancode_jev_features: { "turn-routing": false } },
        KEYED_ENV,
        "turn-routing",
      ),
    ).toBe(false)
    expect(Jev.feature({ banyancode_jev_profile: "aggressive" }, {}, "turn-routing")).toBe(false)
  })

  test("usage snapshots separate physical, cached, and unknown sessions", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    await Jev.ask(askInput({ fetch, sessionID: "usage-1", feature: "judge" }))
    await Jev.ask(askInput({ fetch, sessionID: "usage-1", feature: "judge" }))
    expect(calls).toBe(1)
    expect(Jev.usage("usage-1")).toMatchObject({ requests: 1, cachedHits: 1, sessionID: "usage-1" })
    expect(Jev.usage("usage-1").features).toMatchObject({ judge: 2 })
    expect(Jev.usage("no-such-session")).toMatchObject({ requests: 0, cachedHits: 0, estimatedCost: 0 })
  })
})

describe("Jev token estimates", () => {
  test("uses a conservative UTF-8 bound, not chars/4", () => {
    expect(Jev.estimateTokens("日".repeat(100), {})).toBe(300)
    expect(Jev.estimateTokens("a".repeat(12), {})).toBe(12)
  })
})

describe("Jev.decide on the shared core", () => {
  test("supports sessionID, scope, and signal without changing the success shape", async () => {
    const fetch = async (): Promise<Response> =>
      jsonResponse(choiceAnswer("decision", "deny", { allow: 0.2, deny: 0.8 }, 0.75))
    const result = await Jev.decide({
      state: "decide-core state",
      question: "Allow?",
      choices: ["allow", "deny"],
      env: KEYED_ENV,
      fetch,
      sessionID: "decide-1",
      scope: "turn",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.choice).toBe("deny")
    expect(result.confidence).toBe(0.75)
    expect(Jev.usage("decide-1")).toMatchObject({ requests: 1 })
  })

  test("decide honors per-turn budgets via scope", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      return jsonResponse(choiceAnswer("decision", "allow", { allow: 0.9, deny: 0.1 }, 0.8))
    }
    const config: Jev.Config = { banyancode_jev_budget: { perTurnCalls: 1 } }
    const base = {
      state: "x",
      question: "Allow?",
      choices: ["allow", "deny"],
      env: KEYED_ENV,
      fetch,
      config,
      sessionID: "decide-2",
      scope: "turn",
    } as const
    expect((await Jev.decide({ ...base, state: "first" })).ok).toBe(true)
    expect(await Jev.decide({ ...base, state: "second" })).toMatchObject({ ok: false, reason: "budget-exceeded" })
    expect(calls).toBe(1)
  })
})

describe("Jev.ask spend settlement", () => {
  test("tokens-only usage derives estimated cost and frees pending", async () => {
    const fetch = async (): Promise<Response> =>
      jsonResponse({
        ...choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8),
        usage: { input_tokens: 1000, output_tokens: 10 },
      })
    const result = await Jev.ask(askInput({ fetch, sessionID: "spend-tokens" }))
    expect(result.ok).toBe(true)
    const snap = Jev.usage("spend-tokens")
    expect(snap.pendingCost).toBe(0)
    expect(snap.estimatedCost).toBeGreaterThan(0)
    expect(snap.cost).toBe(0)
  })

  test("429 retry settles without accumulating pending", async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const result = await Jev.ask(askInput({ fetch, sessionID: "spend-retry" }))
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    const snap = Jev.usage("spend-retry")
    expect(snap.requests).toBe(2)
    expect(snap.pendingCost).toBe(0)
  })

  test("HTTP failure frees the cap for the next call", async () => {
    const questions = { q1: { type: "choice", instructions: "Pick.", criteria: { a: null, b: null } } } as const
    const est = Jev.estimateTokens("cap-free-state", questions)
    const single = (est * Jev.JEV_USD_PER_MTOKEN) / 1_000_000
    const config: Jev.Config = { banyancode_jev_budget: { perSessionUsd: single * 1.5 } }
    let fail = true
    const fetch = async (): Promise<Response> => {
      if (fail) {
        fail = false
        return new Response("bad", { status: 422 })
      }
      return jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    }
    const first = await Jev.ask(
      askInput({ state: "cap-free-state", fetch, config, sessionID: "spend-free", questions: { ...questions } }),
    )
    expect(first).toMatchObject({ ok: false, reason: "http-error", status: 422 })
    expect(Jev.usage("spend-free").pendingCost).toBe(0)
    const second = await Jev.ask(
      askInput({ state: "cap-free-state2", fetch, config, sessionID: "spend-free", questions: { ...questions } }),
    )
    expect(second.ok).toBe(true)
  })

  test("success without usage retains conservative dollar spend, not pending", async () => {
    const fetch = async (): Promise<Response> => jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8))
    const result = await Jev.ask(askInput({ fetch, sessionID: "spend-nousage" }))
    expect(result.ok).toBe(true)
    const snap = Jev.usage("spend-nousage")
    expect(snap.pendingCost).toBe(0)
    expect(snap.estimatedCost).toBeGreaterThan(0)
    expect(snap.cost).toBe(0)
  })

  test("cancelled sole caller frees the permit for the next request", async () => {
    let aborted = false
    const fetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("cancelled", "AbortError"))
        })
      })
    const config: Jev.Config = { banyancode_jev_client: { maxInflight: 1 } }
    const controller = new AbortController()
    const pending = Jev.ask(askInput({ fetch, signal: controller.signal, sessionID: "spend-cancel", config }))
    await Bun.sleep(10)
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, reason: "cancelled" })
    expect(aborted).toBe(true)
    const next = await Jev.ask(
      askInput({
        state: "after-cancel",
        fetch: async () => jsonResponse(choiceAnswer("q1", "a", { a: 0.9, b: 0.1 }, 0.8)),
        sessionID: "spend-cancel",
        config,
      }),
    )
    expect(next.ok).toBe(true)
  })
})
