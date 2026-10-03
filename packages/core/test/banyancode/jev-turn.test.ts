import { beforeEach, describe, expect, test } from "bun:test"
import { resetJevStateForTests } from "../../src/banyancode/jev"
import { MIN_CONFIDENCE, isTurnRoutingEnabled, planTurn } from "../../src/banyancode/jev-turn"

const KINDS = ["read_only", "small_edit", "multi_file_edit", "needs_plan", "other"]
const TIERS = ["fast", "strong"]

interface Captured {
  url: string
  body: any
}

const choiceAnswer = (choice: string, all: string[], confidence: number) => ({
  type: "choice",
  choice,
  probabilities: Object.fromEntries(all.map((entry) => [entry, entry === choice ? 0.8 : 0.2 / (all.length - 1)])),
  confidence,
})

const makeFetch = (handler: (body: any) => unknown, captured: Captured[]) =>
  (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    captured.push({ url, body })
    return { ok: true, status: 200, json: async () => handler(body) } as Response
  }) as typeof fetch

const turnHandler = (body: any) => ({
  answers: {
    "turn-kind": choiceAnswer("small_edit", KINDS, 0.8),
    "turn-tier": choiceAnswer("strong", TIERS, 0.8),
  },
})

const TIERED = {
  banyancode_jev_profile: "aggressive",
  banyancode_jev_model_tiers: { fast: "prov/fast-model", strong: "prov/strong-model" },
} as const

beforeEach(() => {
  resetJevStateForTests()
})

describe("isTurnRoutingEnabled", () => {
  test("defaults off without profile or per-feature enable", () => {
    expect(isTurnRoutingEnabled(undefined, {})).toBe(false)
    expect(isTurnRoutingEnabled({}, {})).toBe(false)
    expect(isTurnRoutingEnabled({ banyancode_jev_profile: "conservative" }, {})).toBe(false)
  })

  test("aggressive profile with a key enables turn-routing", () => {
    expect(isTurnRoutingEnabled({ banyancode_jev_profile: "aggressive" }, { BANYANCODE_JEV_API_KEY: "k" })).toBe(true)
  })

  test("aggressive profile without a key stays off (no request possible)", () => {
    expect(isTurnRoutingEnabled({ banyancode_jev_profile: "aggressive" }, {})).toBe(false)
  })

  test("explicit apiKey counts as connecting Jev", () => {
    expect(isTurnRoutingEnabled({ banyancode_jev_profile: "aggressive" }, {}, "turn-routing", "test-key")).toBe(true)
  })

  test("explicit per-feature flags win over the profile", () => {
    expect(
      isTurnRoutingEnabled(
        { banyancode_jev_profile: "conservative", banyancode_jev_features: { "turn-routing": true } },
        {},
        "turn-routing",
        "test-key",
      ),
    ).toBe(true)
    expect(
      isTurnRoutingEnabled(
        { banyancode_jev_profile: "aggressive", banyancode_jev_features: { "turn-routing": false } },
        { BANYANCODE_JEV_API_KEY: "k" },
      ),
    ).toBe(false)
  })

  test("explicit global disable always wins", () => {
    expect(
      isTurnRoutingEnabled(
        { banyancode_jev_enabled: false, banyancode_jev_profile: "aggressive" },
        { BANYANCODE_JEV_API_KEY: "k" },
      ),
    ).toBe(false)
  })
})

describe("planTurn", () => {
  test("returns undefined without a network call when the policy is off", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "explain this function",
      config: {},
      apiKey: "test-key",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(plan).toBeUndefined()
    expect(captured.length).toBe(0)
  })

  test("no-key regression: aggressive policy without a key makes no request", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "explain this function",
      config: { banyancode_jev_profile: "aggressive" },
      env: {},
      fetch: makeFetch(turnHandler, captured),
    })
    expect(plan).toBeUndefined()
    expect(captured.length).toBe(0)
  })

  test("explicit disable makes no request even with a key", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "explain this function",
      config: { banyancode_jev_enabled: false, banyancode_jev_profile: "aggressive" },
      apiKey: "test-key",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(plan).toBeUndefined()
    expect(captured.length).toBe(0)
  })

  test("asks kind and tier in ONE request on a shared bounded state", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "fix the login redirect",
      config: {
        banyancode_jev_profile: "aggressive",
        banyancode_jev_model_tiers: {
          fast: "prov/fast-model",
          strong: "prov/strong-model",
          fastThinking: "low",
          strongThinking: "high",
        },
      },
      apiKey: "test-key",
      sessionID: "turn-single",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(plan?.kind).toBe("small_edit")
    expect(plan?.tier).toBe("strong")
    expect(plan?.model).toBe("prov/strong-model")
    expect(plan?.thinking).toBe("high")
    expect(typeof plan?.latencyMs).toBe("number")
    expect(captured.length).toBe(1)
    expect(Object.keys(captured[0].body.questions).sort()).toEqual(["turn-kind", "turn-tier"])
    expect(captured[0].body.questions["turn-kind"].type).toBe("choice")
    expect(captured[0].body.questions["turn-tier"].type).toBe("choice")
  })

  test("second identical call serves metadata from cache without a request", async () => {
    const captured: Captured[] = []
    const base = {
      task: "fix the login redirect",
      config: { ...TIERED },
      apiKey: "test-key",
      sessionID: "turn-cached",
      fetch: makeFetch(turnHandler, captured),
    } as const
    const first = await planTurn({ ...base })
    expect(first?.cached).toBe(false)
    const second = await planTurn({ ...base })
    expect(second?.kind).toBe("small_edit")
    expect(second?.cached).toBe(true)
    expect(captured.length).toBe(1)
  })

  test("env-provided key connects without an explicit apiKey", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "fix the login redirect",
      config: { ...TIERED },
      env: { BANYANCODE_JEV_API_KEY: "env-key" },
      sessionID: "turn-env",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(plan?.kind).toBe("small_edit")
    expect(plan?.tier).toBe("strong")
    expect(captured.length).toBe(1)
  })

  test("invalid-answer fallback: malformed payload resolves undefined", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "fix the login redirect",
      config: { ...TIERED },
      apiKey: "test-key",
      sessionID: "turn-invalid",
      fetch: makeFetch(() => ({ answers: {} }), captured),
    })
    expect(plan).toBeUndefined()
  })

  test("invalid-answer fallback: unknown choice resolves undefined", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "fix the login redirect",
      config: { ...TIERED },
      apiKey: "test-key",
      sessionID: "turn-unknown",
      fetch: makeFetch(
        () => ({
          answers: {
            "turn-kind": choiceAnswer("not-a-kind", [...KINDS, "not-a-kind"], 0.9),
            "turn-tier": choiceAnswer("fast", TIERS, 0.9),
          },
        }),
        captured,
      ),
    })
    expect(plan).toBeUndefined()
  })

  test("uncertainty fallback: low confidence resolves undefined", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "fix the login redirect",
      config: { ...TIERED },
      apiKey: "test-key",
      sessionID: "turn-uncertain",
      fetch: makeFetch(
        () => ({
          answers: {
            "turn-kind": choiceAnswer("small_edit", KINDS, MIN_CONFIDENCE - 0.3),
            "turn-tier": choiceAnswer("fast", TIERS, 0.9),
          },
        }),
        captured,
      ),
    })
    expect(plan).toBeUndefined()
  })

  test("per-turn budget stops the second call in the same session scope", async () => {
    const captured: Captured[] = []
    const config = {
      banyancode_jev_profile: "aggressive",
      banyancode_jev_model_tiers: { fast: "prov/fast-model", strong: "prov/strong-model" },
      banyancode_jev_budget: { perTurnCalls: 1 },
    } as const
    const first = await planTurn({
      task: "first task",
      config,
      apiKey: "test-key",
      sessionID: "turn-budget",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(first?.kind).toBe("small_edit")
    const second = await planTurn({
      task: "second task",
      config,
      apiKey: "test-key",
      sessionID: "turn-budget",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(second).toBeUndefined()
    expect(captured.length).toBe(1)
  })

  test("empty task and aborted signal resolve undefined without requests", async () => {
    const captured: Captured[] = []
    expect(
      await planTurn({
        task: "   ",
        config: { banyancode_jev_profile: "aggressive" },
        apiKey: "test-key",
        fetch: makeFetch(turnHandler, captured),
      }),
    ).toBeUndefined()
    const controller = new AbortController()
    controller.abort()
    expect(
      await planTurn({
        task: "fix the login redirect",
        config: { banyancode_jev_profile: "aggressive" },
        apiKey: "test-key",
        signal: controller.signal,
        sessionID: "turn-abort",
        fetch: makeFetch(turnHandler, captured),
      }),
    ).toBeUndefined()
    expect(captured.length).toBe(0)
  })

  test("secret values never reach the request state", async () => {
    const captured: Captured[] = []
    await planTurn({
      task: "fix login where api_key=sk-topsecretvalue123 and password: hunter2-hunter",
      config: { ...TIERED },
      apiKey: "test-key",
      sessionID: "turn-redact",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(captured.length).toBe(1)
    expect(captured[0].body.state).not.toContain("sk-topsecretvalue123")
    expect(captured[0].body.state).not.toContain("hunter2-hunter")
    expect(captured[0].body.state).toContain("[redacted]")
  })

  test("no execution tiers configured makes no request (no pay for log-only advice)", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "fix the login redirect",
      config: { banyancode_jev_profile: "aggressive" },
      apiKey: "test-key",
      sessionID: "turn-notiers",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(plan).toBeUndefined()
    expect(captured.length).toBe(0)
  })

  test("blank tier strings count as unconfigured (no request)", async () => {
    const captured: Captured[] = []
    const plan = await planTurn({
      task: "fix the login redirect",
      config: {
        banyancode_jev_profile: "aggressive",
        banyancode_jev_model_tiers: { fast: "  ", strong: "" },
      },
      apiKey: "test-key",
      sessionID: "turn-blanktiers",
      fetch: makeFetch(turnHandler, captured),
    })
    expect(plan).toBeUndefined()
    expect(captured.length).toBe(0)
  })
})
