import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  classifyDuration,
  clampPercent,
  labelForDuration,
  makeProviderUsage,
  normalizeRateLimitHeaders,
  normalizeWindow,
  observeRateLimitResponse,
  redactSecrets,
  resetObservations,
  toEpochMs,
  unsupportedSnapshot,
} from "../../src/telemetry/provider-usage.js"

const headers = {
  "x-ratelimit-limit-requests": "100",
  "x-ratelimit-remaining-requests": "25",
  "x-ratelimit-reset-requests": String(Math.floor(Date.now() / 1000) + 60),
  "x-ratelimit-limit-tokens": "1000",
  "x-ratelimit-remaining-tokens": "900",
}

beforeEach(() => {
  resetObservations()
})

describe("provider usage model (v1 parity)", () => {
  test("duration classification and labels match v1", () => {
    expect(classifyDuration(18_000)).toBe("five_hour")
    expect(classifyDuration(86_400)).toBe("daily")
    expect(classifyDuration(604_800)).toBe("weekly")
    expect(classifyDuration(2_592_000)).toBe("monthly")
    expect(classifyDuration(undefined)).toBe("unknown")
    expect(labelForDuration(18_000)).toBe("5h")
    expect(labelForDuration(60)).toBeUndefined()
  })

  test("percentages are clamped and never invented", () => {
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(140)).toBe(100)
    const window = normalizeWindow({ id: "w", durationSeconds: 18_000, usedPercent: 40 })
    expect(window.label).toBe("5h")
    expect(window.remainingPercent).toBe(60)
    expect(normalizeWindow({ id: "x" }).usedPercent).toBeUndefined()
    expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  test("rate-limit headers normalize into reported windows", () => {
    const windows = normalizeRateLimitHeaders(headers)
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ id: "rate-limit-requests", kind: "rate_limit", limit: 100, remaining: 25 })
    expect(windows[0]!.usedPercent).toBe(75)
    expect(windows[1]).toMatchObject({ id: "rate-limit-tokens", remaining: 900 })
    expect(normalizeRateLimitHeaders({})).toEqual([])
  })

  test("messages are secret-sanitized", () => {
    expect(redactSecrets("Authorization: Bearer sk-abc123")).not.toContain("sk-abc123")
    expect(redactSecrets("api_key=supersecret")).toContain("[redacted]")
  })
})

describe("provider usage collector", () => {
  const providers = [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
  ]

  test("observed providers report windows; the rest stay unsupported (no invented quota)", async () => {
    observeRateLimitResponse("anthropic", headers)
    const usage = makeProviderUsage({ providers: () => Effect.succeed(providers) })
    const result = await Effect.runPromise(usage.snapshots())
    const anthropic = result.snapshots.find((snapshot) => snapshot.providerID === "anthropic")!
    const openai = result.snapshots.find((snapshot) => snapshot.providerID === "openai")!
    expect(anthropic.status).toBe("available")
    expect(anthropic.confidence).toBe("reported")
    expect(anthropic.windows).toHaveLength(2)
    expect(openai.status).toBe("unsupported")
    expect(openai.windows).toEqual([])
    expect(openai.message).toBe("Usage unavailable")
  })

  test("refresh bypasses the TTL cache and filters by providerID", async () => {
    let now = Date.now()
    const usage = makeProviderUsage({ providers: () => Effect.succeed(providers), now: () => now, ttlMs: 60_000 })
    const first = await Effect.runPromise(usage.snapshots())
    expect(first.snapshots).toHaveLength(2)

    // Still inside the collector TTL: the cached (unsupported) list wins.
    now += 30_000
    observeRateLimitResponse("openai", headers, now)
    const cached = await Effect.runPromise(usage.snapshots())
    expect(cached.snapshots.find((snapshot) => snapshot.providerID === "openai")!.status).toBe("unsupported")

    now += 31_000
    const fresh = await Effect.runPromise(usage.snapshots({ force: true }))
    expect(fresh.snapshots.find((snapshot) => snapshot.providerID === "openai")!.status).toBe("available")

    const one = await Effect.runPromise(usage.snapshots({ providerID: "anthropic" }))
    expect(one.snapshots.map((snapshot) => snapshot.providerID)).toEqual(["anthropic"])
  })

  test("provider-list failures degrade to an empty list instead of throwing", async () => {
    const usage = makeProviderUsage({ providers: () => Effect.fail(new Error("no providers")) })
    expect(await Effect.runPromise(usage.snapshots())).toEqual({ snapshots: [] })
  })

  test("unsupportedSnapshot keeps the v1 label", () => {
    expect(unsupportedSnapshot("openai", "OpenAI", 5)).toEqual({
      providerID: "openai",
      displayName: "OpenAI",
      status: "unsupported",
      confidence: "exact",
      windows: [],
      message: "Usage unavailable",
      fetchedAt: 5,
    })
  })
})

describe("provider usage core seam", () => {
  const providers = [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
    { id: "google", name: "Google" },
  ]

  const coreSnapshot = (input: {
    providerID: string
    displayName: string
    status: "available" | "unsupported" | "error"
  }) => ({
    providerID: input.providerID,
    displayName: input.displayName,
    status: input.status,
    confidence: "exact" as const,
    windows:
      input.status === "available"
        ? [{ id: "five_hour", label: "5h", kind: "quota" as const, usedPercent: 40, remainingPercent: 60 }]
        : [],
    ...(input.status === "unsupported" ? { message: "Usage unavailable" } : {}),
    fetchedAt: 1_000,
  })

  test("core quota rows win; observed headers only fill unsupported rows", async () => {
    observeRateLimitResponse("anthropic", headers)
    observeRateLimitResponse("openai", headers)
    const calls: Array<{ force?: boolean; providerID?: string }> = []
    const usage = makeProviderUsage({
      providers: () => Effect.succeed(providers),
      usage: (input) => {
        calls.push(input ?? {})
        return Effect.succeed({
          snapshots: [
            coreSnapshot({ providerID: "anthropic", displayName: "Anthropic", status: "available" }),
            coreSnapshot({ providerID: "openai", displayName: "OpenAI", status: "unsupported" }),
          ],
        })
      },
    })
    const result = await Effect.runPromise(usage.snapshots())
    const anthropic = result.snapshots.find((snapshot) => snapshot.providerID === "anthropic")!
    const openai = result.snapshots.find((snapshot) => snapshot.providerID === "openai")!
    const google = result.snapshots.find((snapshot) => snapshot.providerID === "google")!

    // Core's exact quota beats the observed rate-limit headers.
    expect(anthropic.confidence).toBe("exact")
    expect(anthropic.windows.map((window) => window.id)).toEqual(["five_hour"])
    // An unsupported core row still serves whatever headers were observed.
    expect(openai.status).toBe("available")
    expect(openai.confidence).toBe("reported")
    expect(openai.windows.map((window) => window.id)).toEqual(["rate-limit-requests", "rate-limit-tokens"])
    // A provider core never reported keeps its placeholder row.
    expect(google.status).toBe("unsupported")
    expect(calls).toEqual([{}])
  })

  test("refresh forces the core seam and filters by provider", async () => {
    const calls: Array<{ force?: boolean; providerID?: string }> = []
    const usage = makeProviderUsage({
      providers: () => Effect.succeed(providers),
      usage: (input) => {
        calls.push(input ?? {})
        return Effect.succeed({
          snapshots: [coreSnapshot({ providerID: "openai", displayName: "OpenAI", status: "available" })],
        })
      },
    })
    await Effect.runPromise(usage.snapshots({ force: true, providerID: "openai" }))
    expect(calls).toEqual([{ force: true, providerID: "openai" }])
  })

  test("a waiting Claude Agent row is not served from the collector cache", async () => {
    let calls = 0
    let available = false
    const usage = makeProviderUsage({
      providers: () => Effect.succeed([{ id: "claude-agent", name: "Claude Agent" }]),
      usage: () => {
        calls++
        return Effect.succeed({
          snapshots: [
            {
              providerID: "claude-agent",
              displayName: "Claude Agent",
              status: available ? ("available" as const) : ("unsupported" as const),
              confidence: "reported" as const,
              windows: available
                ? [{ id: "five_hour", label: "5h", kind: "quota" as const, usedPercent: 51, remainingPercent: 49 }]
                : [],
              ...(available ? {} : { message: "Limits appear after the first response" }),
              fetchedAt: 1_000,
            },
          ],
        })
      },
    })

    const first = await Effect.runPromise(usage.snapshots())
    expect(first.snapshots[0]!.status).toBe("unsupported")
    expect(calls).toBe(1)

    // Still waiting: the collector must re-read instead of caching the placeholder.
    await Effect.runPromise(usage.snapshots())
    expect(calls).toBe(2)

    available = true
    const after = await Effect.runPromise(usage.snapshots())
    expect(after.snapshots[0]!.status).toBe("available")
    expect(calls).toBe(3)

    // Claude Agent rows are local state, so every read observes the latest value.
    await Effect.runPromise(usage.snapshots())
    expect(calls).toBe(4)
  })

  test("a failing core seam degrades to observed rows, never a throw", async () => {
    observeRateLimitResponse("openai", headers)
    const usage = makeProviderUsage({
      providers: () => Effect.succeed(providers),
      usage: () => Effect.fail(new Error("core unavailable")),
    })
    const result = await Effect.runPromise(usage.snapshots())
    expect(result.snapshots.find((snapshot) => snapshot.providerID === "openai")!.status).toBe("available")
    expect(result.snapshots.find((snapshot) => snapshot.providerID === "anthropic")!.status).toBe("unsupported")
  })

  test("the panel payload carries no credential material", async () => {
    const usage = makeProviderUsage({
      providers: () => Effect.succeed(providers),
      usage: () =>
        Effect.succeed({
          snapshots: [coreSnapshot({ providerID: "openai", displayName: "OpenAI", status: "available" })],
        }),
    })
    const result = await Effect.runPromise(usage.snapshots())
    expect(JSON.stringify(result)).not.toMatch(/token|secret|bearer|authorization|api[_-]?key/i)
  })
})
