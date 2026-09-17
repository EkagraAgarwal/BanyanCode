import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Auth } from "@/auth"
import { ProviderUsage } from "@/provider/usage"
import type { Adapter, AdapterContext, FetchImpl } from "@/provider/usage"
import { AnthropicAdapter, normalizeAnthropicUsage } from "@/provider/usage/anthropic"
import { CopilotAdapter, normalizeCopilotUsage } from "@/provider/usage/github-copilot"
import { KimiAdapter, normalizeKimiUsage } from "@/provider/usage/kimi"
import { MiniMaxAdapter, normalizeMiniMaxRemains } from "@/provider/usage/minimax"
import { normalizeZhipuQuota, ZhipuAdapter } from "@/provider/usage/zhipu"

const anthropicFixture = {
  five_hour: { utilization: 0.68, resets_at: "2026-09-17T10:00:00Z" },
  seven_day: { utilization: 39, resets_at: 1_786_000_000 },
  seven_day_sonnet: { utilization: 0.1, resets_at: "2026-09-20T00:00:00Z" },
}

const copilotFixture = {
  quota_snapshots: {
    premium_interactions: { percent_remaining: 78, quota_reset_date_utc: "2026-10-01T00:00:00Z" },
  },
  quota_reset_date: "2026-10-01T00:00:00Z",
}

const copilotEntitlementFixture = {
  quota_snapshots: {
    premium_interactions: { entitlement: 100, remaining: 40 },
  },
}

const kimiFixture = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: 100, remaining: 32, resetTime: "2026-09-17T10:00:00Z" },
    },
    {
      window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
      detail: { limit: "200", remaining: "120", resetTime: "2026-09-20T00:00:00Z" },
    },
  ],
  usage: { limit: 200, remaining: 120, resetTime: "2026-09-20T00:00:00Z" },
}

const zhipuFixture = {
  success: true,
  code: 200,
  msg: "ok",
  data: {
    level: "LITE",
    limits: [{ type: "TOKENS_LIMIT", percentage: 25, unit: 1, number: 7, nextResetTime: "2026-09-20T00:00:00Z" }],
  },
}

const minimaxFixture = {
  data: {
    current_subscribe_title: "Pro plan",
    model_remains: [
      {
        current_interval_total_count: 100,
        current_interval_usage_count: 68,
        start_time: "2026-09-17T05:00:00Z",
        end_time: "2026-09-17T10:00:00Z",
        current_weekly_total_count: 500,
        current_weekly_usage_count: 200,
        weekly_start_time: "2026-09-14T00:00:00Z",
        weekly_end_time: "2026-09-21T00:00:00Z",
      },
    ],
  },
  base_resp: { status_code: 0, status_msg: "ok" },
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })

const stubFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchImpl => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = ((input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(handler(String(input), init))
  }) as FetchImpl
  return Object.assign(impl, { calls })
}

const oauth = (access: string, expires: number): Auth.Info =>
  new Auth.Oauth({ type: "oauth", refresh: "refresh-token", access, expires })

const apiKey = (key: string): Auth.Info => new Auth.Api({ type: "api", key })

const ctxFor = (
  providerID: string,
  auth: Auth.Info | undefined,
  fetch: FetchImpl,
  options: Record<string, unknown> = {},
): AdapterContext => ({
  providerID,
  displayName: providerID,
  auth,
  options,
  accountKey: "test",
  fetch,
})

const fetchError = async (adapter: Adapter, ctx: AdapterContext) =>
  Effect.runPromise(Effect.flip(adapter.fetch(ctx)))

describe("remaining provider-usage adapters", () => {
  test("anthropic fixture normalizes session and weekly windows, preserves extras", () => {
    const snapshot = normalizeAnthropicUsage(anthropicFixture, { providerID: "anthropic", displayName: "Anthropic" })
    expect(snapshot.status).toBe("available")
    expect(snapshot.confidence).toBe("exact")
    expect(snapshot.windows).toHaveLength(3)
    const byId = Object.fromEntries(snapshot.windows.map((w) => [w.id, w]))
    expect(byId["five_hour"].usedPercent).toBeCloseTo(68)
    expect(byId["five_hour"].remainingPercent).toBeCloseTo(32)
    expect(byId["five_hour"].durationSeconds).toBe(18_000)
    expect(byId["five_hour"].resetsAt).toBe(Date.parse("2026-09-17T10:00:00Z"))
    expect(byId["seven_day"].usedPercent).toBe(39)
    expect(byId["seven_day_sonnet"].label).toBe("Sonnet 7d")
    expect(byId["seven_day_sonnet"].durationSeconds).toBe(604_800)
  })

  test("copilot fixture yields monthly remaining window with reset", () => {
    const snapshot = normalizeCopilotUsage(copilotFixture, { providerID: "github-copilot", displayName: "Copilot" })
    expect(snapshot.status).toBe("available")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0].id).toBe("monthly")
    expect(snapshot.windows[0].remainingPercent).toBe(78)
    expect(snapshot.windows[0].resetsAt).toBe(Date.parse("2026-10-01T00:00:00Z"))
  })

  test("copilot falls back to entitlement/remaining ratio", () => {
    const snapshot = normalizeCopilotUsage(copilotEntitlementFixture, {
      providerID: "github-copilot",
      displayName: "Copilot",
    })
    expect(snapshot.windows[0].remainingPercent).toBe(40)
    expect(snapshot.windows[0].resetsAt).toBeUndefined()
  })

  test("kimi fixture normalizes 5h and weekly windows, dedupes top-level usage", () => {
    const snapshot = normalizeKimiUsage(kimiFixture, { providerID: "kimi-for-coding", displayName: "Kimi" })
    expect(snapshot.status).toBe("available")
    expect(snapshot.windows).toHaveLength(2)
    expect(snapshot.windows[0].label).toBe("5h")
    expect(snapshot.windows[0].remainingPercent).toBe(32)
    expect(snapshot.windows[0].durationSeconds).toBe(18_000)
    expect(snapshot.windows[1].label).toBe("Weekly")
    expect(snapshot.windows[1].remainingPercent).toBe(60)
  })

  test("kimi preserves unknown window shapes instead of dropping them", () => {
    const snapshot = normalizeKimiUsage(
      {
        limits: [
          {
            window: { duration: 42, timeUnit: "TIME_UNIT_FORTNIGHT" },
            detail: { limit: 100, remaining: 50 },
          },
        ],
      },
      { providerID: "kimi-for-coding", displayName: "Kimi" },
    )
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0].label).toBe("Window")
    expect(snapshot.windows[0].remainingPercent).toBe(50)
  })

  test("zhipu fixture yields token quota window with used percent", () => {
    const snapshot = normalizeZhipuQuota(zhipuFixture, { providerID: "zhipuai-coding-plan", displayName: "Zhipu" })
    expect(snapshot.status).toBe("available")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0].label).toBe("Weekly")
    expect(snapshot.windows[0].usedPercent).toBe(25)
    expect(snapshot.windows[0].remainingPercent).toBe(75)
    expect(snapshot.windows[0].resetsAt).toBe(Date.parse("2026-09-20T00:00:00Z"))
  })

  test("zhipu rejects non-success payloads without leaking bodies", () => {
    expect(() =>
      normalizeZhipuQuota({ success: false, code: 401, msg: "bad key" }, { providerID: "z", displayName: "Z" }),
    ).toThrow("Zhipu bad key")
    expect(() => normalizeZhipuQuota({ nope: true }, { providerID: "z", displayName: "Z" })).toThrow()
  })

  test("zhipu clamps malformed percentages", () => {
    const snapshot = normalizeZhipuQuota(
      {
        success: true,
        code: 200,
        data: { limits: [{ type: "TOKENS_LIMIT", percentage: 150, unit: 3, number: 5 }] },
      },
      { providerID: "z", displayName: "Z" },
    )
    expect(snapshot.windows[0].usedPercent).toBe(100)
    expect(snapshot.windows[0].remainingPercent).toBe(0)
    expect(snapshot.windows[0].label).toBe("5h")
  })

  test("minimax fixture yields interval and weekly remains windows", () => {
    const snapshot = normalizeMiniMaxRemains(minimaxFixture, {
      providerID: "minimax-cn-coding-plan",
      displayName: "MiniMax",
    })
    expect(snapshot.status).toBe("available")
    expect(snapshot.windows).toHaveLength(2)
    expect(snapshot.windows[0].label).toBe("5h")
    expect(snapshot.windows[0].remainingPercent).toBe(68)
    expect(snapshot.windows[0].durationSeconds).toBe(18_000)
    expect(snapshot.windows[1].label).toBe("Weekly")
    expect(snapshot.windows[1].remainingPercent).toBe(40)
  })

  test("minimax surfaces non-zero status codes as upstream errors", () => {
    expect(() =>
      normalizeMiniMaxRemains(
        { data: {}, base_resp: { status_code: 1001, status_msg: "quota exceeded" } },
        { providerID: "m", displayName: "M" },
      ),
    ).toThrow("MiniMax quota exceeded")
  })

  test("supports gates on provider and auth type", () => {
    expect(AnthropicAdapter.supports({ providerID: "anthropic", hasAuth: true, authType: "oauth" })).toBe(true)
    expect(AnthropicAdapter.supports({ providerID: "anthropic", hasAuth: true, authType: "api" })).toBe(false)
    expect(AnthropicAdapter.supports({ providerID: "anthropic", hasAuth: false })).toBe(true)
    expect(AnthropicAdapter.supports({ providerID: "openai", hasAuth: true, authType: "oauth" })).toBe(false)
    expect(CopilotAdapter.supports({ providerID: "github-copilot", hasAuth: true, authType: "oauth" })).toBe(true)
    expect(CopilotAdapter.supports({ providerID: "github-copilot-enterprise", hasAuth: false })).toBe(true)
    expect(CopilotAdapter.supports({ providerID: "openai", hasAuth: false })).toBe(false)
    expect(KimiAdapter.supports({ providerID: "moonshotai", hasAuth: true, authType: "api" })).toBe(true)
    expect(KimiAdapter.supports({ providerID: "kimi-for-coding", hasAuth: false })).toBe(true)
    expect(KimiAdapter.supports({ providerID: "openai", hasAuth: false })).toBe(false)
    expect(ZhipuAdapter.supports({ providerID: "zhipu", hasAuth: true, authType: "api" })).toBe(true)
    expect(MiniMaxAdapter.supports({ providerID: "minimax", hasAuth: true, authType: "api" })).toBe(true)
    expect(MiniMaxAdapter.supports({ providerID: "minimax-cn-coding-plan", hasAuth: false })).toBe(true)
  })

  test("all five adapters are registered built-ins", () => {
    const ids = ProviderUsage.listAdapters().map((a) => a.id)
    for (const id of [
      "banyan-usage-anthropic",
      "banyan-usage-github-copilot",
      "banyan-usage-kimi",
      "banyan-usage-zhipu",
      "banyan-usage-minimax",
    ]) {
      expect(ids).toContain(id)
    }
  })

  test("oauth adapters reject api keys as unsupported, not as quota", async () => {
    const fetch = stubFetch(() => jsonResponse({}))
    const anthropicError = await fetchError(
      AnthropicAdapter,
      ctxFor("anthropic", apiKey("sk-key"), fetch),
    )
    expect(anthropicError.reason).toBe("unsupported")
    const copilotError = await fetchError(
      CopilotAdapter,
      ctxFor("github-copilot", apiKey("gh-key"), fetch),
    )
    expect(copilotError.reason).toBe("unsupported")
  })

  test("missing credentials are unauthenticated and secret-safe", async () => {
    const fetch = stubFetch(() => jsonResponse({}))
    for (const [adapter, providerID] of [
      [AnthropicAdapter, "anthropic"],
      [CopilotAdapter, "github-copilot"],
      [KimiAdapter, "kimi-for-coding"],
      [ZhipuAdapter, "zhipuai-coding-plan"],
      [MiniMaxAdapter, "minimax-cn-coding-plan"],
    ] as const) {
      const error = await fetchError(adapter, ctxFor(providerID, undefined, fetch))
      expect(error.reason).toBe("unauthenticated")
      expect(JSON.stringify(error)).not.toContain("sk-")
    }
  })

  test("401/403 map to unauthenticated, 429 to rate_limited, 500 to upstream", async () => {
    const cases = [
      { status: 401, reason: "unauthenticated" },
      { status: 403, reason: "unauthenticated" },
      { status: 429, reason: "rate_limited" },
      { status: 500, reason: "upstream" },
    ] as const
    for (const { status, reason } of cases) {
      const fetch = stubFetch(() => new Response("boom", { status }))
      const error = await fetchError(
        KimiAdapter,
        ctxFor("kimi-for-coding", apiKey("k2-key"), fetch),
      )
      expect(error.reason).toBe(reason)
      expect(error.message).not.toContain("k2-key")
      expect(error.message).not.toContain("boom")
    }
  })

  test("network failures are typed and secret-safe", async () => {
    const failing: FetchImpl = () => Promise.reject(new Error("socket hang up Bearer sk-secret"))
    const error = await fetchError(AnthropicAdapter, ctxFor("anthropic", oauth("tok", Date.now() + 60_000), failing))
    expect(error.reason).toBe("network")
    expect(error.message).not.toContain("sk-secret")
  })

  test("successful fetches never expose credentials", async () => {
    const cases: Array<{ adapter: typeof KimiAdapter; providerID: string; auth: Auth.Info; payload: unknown }> = [
      { adapter: AnthropicAdapter, providerID: "anthropic", auth: oauth("anth-token", Date.now() + 60_000), payload: anthropicFixture },
      { adapter: CopilotAdapter, providerID: "github-copilot", auth: oauth("gh-token", Date.now() + 60_000), payload: copilotFixture },
      { adapter: KimiAdapter, providerID: "kimi-for-coding", auth: apiKey("kimi-secret"), payload: kimiFixture },
      { adapter: ZhipuAdapter, providerID: "zhipuai-coding-plan", auth: apiKey("zhipu-secret"), payload: zhipuFixture },
      { adapter: MiniMaxAdapter, providerID: "minimax-cn-coding-plan", auth: apiKey("minimax-secret"), payload: minimaxFixture },
    ]
    for (const { adapter, providerID, auth, payload } of cases) {
      const snapshot = await Effect.runPromise(
        adapter.fetch(ctxFor(providerID, auth, stubFetch(() => jsonResponse(payload)))),
      )
      expect(snapshot.status).toBe("available")
      const encoded = JSON.stringify(snapshot)
      expect(encoded).not.toContain("anth-token")
      expect(encoded).not.toContain("gh-token")
      expect(encoded).not.toContain("kimi-secret")
      expect(encoded).not.toContain("zhipu-secret")
      expect(encoded).not.toContain("minimax-secret")
    }
  })

  test("zhipu sends the raw key and minimax/kimi send bearer; regional hosts switch by baseURL", async () => {
    const zhipuFetch = stubFetch(() => jsonResponse(zhipuFixture))
    await Effect.runPromise(
      ZhipuAdapter.fetch(ctxFor("zhipuai-coding-plan", apiKey("raw-key"), zhipuFetch, { baseURL: "https://api.z.ai/api/coding/paas/v4" })),
    )
    const zhipuCall = (zhipuFetch as unknown as { calls: Array<{ url: string; init?: RequestInit }> }).calls[0]
    expect(zhipuCall.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit")
    expect((zhipuCall.init?.headers as Record<string, string>)["authorization"]).toBe("raw-key")

    const defaultFetch = stubFetch(() => jsonResponse(zhipuFixture))
    await Effect.runPromise(ZhipuAdapter.fetch(ctxFor("zhipu", apiKey("k"), defaultFetch)))
    expect((defaultFetch as unknown as { calls: Array<{ url: string }> }).calls[0].url).toBe(
      "https://bigmodel.cn/api/monitor/usage/quota/limit",
    )

    const minimaxFetch = stubFetch(() => jsonResponse(minimaxFixture))
    await Effect.runPromise(
      MiniMaxAdapter.fetch(ctxFor("minimax", apiKey("k"), minimaxFetch, { baseURL: "https://api.minimax.io/v1" })),
    )
    const minimaxCall = (minimaxFetch as unknown as { calls: Array<{ url: string; init?: RequestInit }> }).calls[0]
    expect(minimaxCall.url).toBe("https://www.minimax.io/v1/api/openplatform/coding_plan/remains")
    expect((minimaxCall.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer k")

    const copilotFetch = stubFetch(() => jsonResponse(copilotFixture))
    await Effect.runPromise(
      CopilotAdapter.fetch(ctxFor("github-copilot", oauth("gh-tok", Date.now() + 60_000), copilotFetch)),
    )
    const copilotCall = (copilotFetch as unknown as { calls: Array<{ url: string; init?: RequestInit }> }).calls[0]
    expect((copilotCall.init?.headers as Record<string, string>)["authorization"]).toBe("token gh-tok")
  })
})
