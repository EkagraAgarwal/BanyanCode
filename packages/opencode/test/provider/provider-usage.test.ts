import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ProviderUsage } from "@/provider/usage"
import type { FetchImpl } from "@/provider/usage"
import { normalizeOpenCodeGoUsage } from "@/provider/usage/opencode-go"
import { normalizeCodexUsage } from "@/provider/usage/openai-codex"
import { normalizeOpenRouterKey } from "@/provider/usage/openrouter"
import { normalizeRateLimitHeaders } from "@/provider/usage/rate-limit-headers"
import { testEffect } from "../lib/effect"

const goFixture = {
  windows: [
    { id: "rolling", label: "Rolling", duration_seconds: 18_000, used_percent: 68, resets_at: 1_786_000_000 },
    { id: "weekly", label: "Weekly", duration_seconds: 604_800, used_percent: 39, resets_at: 1_786_000_000_000 },
    { id: "monthly", label: "Monthly", duration_seconds: 2_592_000, used_percent: 75 },
  ],
}

const codexFixture = {
  rate_limit: {
    primary_window: { used_percent: 68, limit_window_seconds: 18_000, reset_at: 1_786_000_000 },
    secondary_window: { used_percent: 39, limit_window_seconds: 604_800, reset_at: 1_786_000_000_000 },
  },
  additional_rate_limits: [
    {
      limit_name: "codex-spark",
      metered_feature: "codex_bengalfox",
      title: "Spark",
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 3_600,
          reset_after_seconds: 1_800,
        },
      },
    },
  ],
}

const openRouterFixture = { data: { label: "key", limit: 100, usage: 25 } }

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })

const stubFetch = (handler: (url: string, init?: RequestInit) => Response): FetchImpl => (input, init) =>
  Promise.resolve(handler(String(input), init))

const providerInfo = (id: string, name: string): Provider.Info => ({
  id: ProviderV2.ID.make(id),
  name,
  source: "api",
  env: [],
  options: {},
  models: {},
})

const authApi = (key: string): Auth.Info => new Auth.Api({ type: "api", key })

const oauth = (access: string, expires: number, accountId?: string): Auth.Info =>
  new Auth.Oauth({
    type: "oauth",
    refresh: "refresh-token",
    access,
    expires,
    ...(accountId ? { accountId } : {}),
  })

describe("provider-usage normalization", () => {
  test("opencode-go fixture normalizes rolling/weekly/monthly windows", () => {
    const snapshot = normalizeOpenCodeGoUsage(goFixture, { providerID: "opencode", displayName: "OpenCode Go" })
    expect(snapshot.status).toBe("available")
    expect(snapshot.confidence).toBe("exact")
    expect(snapshot.windows).toHaveLength(3)
    expect(snapshot.windows[0].remainingPercent).toBe(32)
    expect(snapshot.windows[0].resetsAt).toBe(1_786_000_000_000)
    expect(snapshot.windows[1].resetsAt).toBe(1_786_000_000_000)
    expect(snapshot.windows[2].remainingPercent).toBe(25)
    expect(snapshot.balance).toBeUndefined()
  })

  test("codex wham fixture classifies primary/secondary by limit_window_seconds", () => {
    const snapshot = normalizeCodexUsage(codexFixture, { providerID: "openai", displayName: "ChatGPT" })
    expect(snapshot.windows).toHaveLength(3)
    const byId = Object.fromEntries(snapshot.windows.map((w) => [w.id, w]))
    expect(byId["primary"].durationSeconds).toBe(18_000)
    expect(byId["primary"].label).toBe("5h")
    expect(byId["primary"].remainingPercent).toBe(32)
    expect(byId["primary"].resetsAt).toBe(1_786_000_000_000)
    expect(byId["secondary"].durationSeconds).toBe(604_800)
    expect(byId["secondary"].label).toBe("1w")
    expect(byId["secondary"].remainingPercent).toBe(61)
    expect(byId["spark"].label).toBe("Spark")
    expect(byId["spark"].durationSeconds).toBe(3_600)
    expect(byId["spark"].remainingPercent).toBe(90)
  })

  test("codex reset_after_seconds resolves relative to fetchedAt", () => {
    const fetchedAt = 1_700_000_000_000
    const snapshot = normalizeCodexUsage(
      {
        rate_limit: {
          primary_window: {
            used_percent: 50,
            limit_window_seconds: 18_000,
            reset_after_seconds: 3_600,
          },
        },
      },
      { providerID: "openai", displayName: "ChatGPT", fetchedAt },
    )
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0].resetsAt).toBe(fetchedAt + 3_600_000)
  })

  test("codex spark matches codex-spark name in flat gist shape", () => {
    const snapshot = normalizeCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_786_000_000 },
        },
        additional_rate_limits: [
          {
            id: "codex-spark",
            title: "Codex Spark 5-hour",
            primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: 1_786_000_000 },
          },
        ],
      },
      { providerID: "openai", displayName: "ChatGPT" },
    )
    const byId = Object.fromEntries(snapshot.windows.map((w) => [w.id, w]))
    expect(byId["spark"].label).toBe("Codex Spark 5-hour")
    expect(byId["spark"].usedPercent).toBe(5)
  })

  test("codex fractional percentages scale and out-of-range values clamp", () => {
    const snapshot = normalizeCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 0.68, limit_window_seconds: 18_000, reset_at: 1_786_000_000 },
          secondary_window: { used_percent: 150, limit_window_seconds: 604_800, reset_at: 1_786_000_000 },
        },
      },
      { providerID: "openai", displayName: "ChatGPT" },
    )
    const byId = Object.fromEntries(snapshot.windows.map((w) => [w.id, w]))
    expect(byId["primary"].usedPercent).toBeCloseTo(68, 6)
    expect(byId["secondary"].usedPercent).toBe(100)
    expect(byId["secondary"].remainingPercent).toBe(0)
  })

  test("codex drops unknown metered features without a label and fails with no usable windows", () => {
    const withUnknown = normalizeCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_786_000_000 },
        },
        additional_rate_limits: [{ metered_feature: "mystery_feature_xyz", rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 60 } } }],
      },
      { providerID: "openai", displayName: "ChatGPT" },
    )
    expect(withUnknown.windows).toHaveLength(1)
    expect(withUnknown.windows[0].id).toBe("primary")
    expect(() =>
      normalizeCodexUsage(
        { rate_limit: { primary_window: null, secondary_window: null }, additional_rate_limits: [] },
        { providerID: "openai", displayName: "ChatGPT" },
      ),
    ).toThrow()
    expect(() =>
      normalizeCodexUsage({ unexpected: "shape" }, { providerID: "openai", displayName: "ChatGPT" }),
    ).toThrow()
  })

  test("codex legacy limits shape still parses", () => {
    const snapshot = normalizeCodexUsage(
      { limits: { primary: { duration_seconds: 18_000, used_percent: 68, resets_at: 1_786_000_000 } } },
      { providerID: "openai", displayName: "ChatGPT" },
    )
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0].usedPercent).toBe(68)
    expect(snapshot.windows[0].durationSeconds).toBe(18_000)
  })

  test("openrouter fixture yields credits window and balance", () => {
    const snapshot = normalizeOpenRouterKey(openRouterFixture, {
      providerID: "openrouter",
      displayName: "OpenRouter",
    })
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0].usedPercent).toBe(25)
    expect(snapshot.windows[0].remaining).toBe(75)
    expect(snapshot.balance?.remaining).toBe(75)
  })

  test("malformed percentages are clamped, never fabricated", () => {
    const over = Banyan.normalizeWindow({ id: "w", usedPercent: 150 })
    expect(over.usedPercent).toBe(100)
    expect(over.remainingPercent).toBe(0)
    const negative = Banyan.normalizeWindow({ id: "w", usedPercent: -5 })
    expect(negative.usedPercent).toBe(0)
    expect(negative.remainingPercent).toBe(100)
    const absent = Banyan.normalizeWindow({ id: "w" })
    expect(absent.usedPercent).toBeUndefined()
    expect(absent.remainingPercent).toBeUndefined()
  })

  test("duration classification covers five-hour, weekly, monthly, unknown", () => {
    expect(Banyan.classifyDuration(18_000)).toBe("five_hour")
    expect(Banyan.classifyDuration(604_800)).toBe("weekly")
    expect(Banyan.classifyDuration(2_592_000)).toBe("monthly")
    expect(Banyan.classifyDuration(12_345)).toBe("unknown")
    expect(Banyan.classifyDuration(undefined)).toBe("unknown")
    expect(Banyan.labelForDuration(18_000)).toBe("5h")
    expect(Banyan.labelForDuration(604_800)).toBe("1w")
    expect(Banyan.labelForDuration(12_345)).toBeUndefined()
  })

  test("rate-limit headers normalize to reported windows", () => {
    const windows = normalizeRateLimitHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "40",
      "x-ratelimit-reset-requests": "1_786_000_000",
    })
    expect(windows).toHaveLength(1)
    expect(windows[0].kind).toBe("rate_limit")
    expect(windows[0].limit).toBe(100)
    expect(windows[0].remaining).toBe(40)
    expect(normalizeRateLimitHeaders({})).toHaveLength(0)
  })

  test("secret redaction strips tokens and account headers", () => {
    const dirty = "failed with Bearer sk-abc123 and ChatGPT-Account-Id: acc-1 api_key=topsecret"
    const clean = Banyan.redactSecrets(dirty)
    expect(clean).not.toContain("sk-abc123")
    expect(clean).not.toContain("acc-1")
    expect(clean).not.toContain("topsecret")
  })
})

describe("ProviderUsage.Service", () => {
  beforeEach(() => {
    ProviderUsage.resetUsageAdapters()
  })

  const serviceLayer = (
    auths: Record<string, Auth.Info>,
    providers: Record<string, Provider.Info>,
    fetchImpl: FetchImpl,
    onSet?: (providerID: string, info: Auth.Info) => void,
  ) =>
    ProviderUsage.layerWithOptions({ fetchImpl }).pipe(
      Layer.provide(
        Layer.mock(Auth.Service, {
          all: () => Effect.succeed(auths),
          set: (key: string, info: Auth.Info) => {
            onSet?.(key, info)
            auths[key] = info
            return Effect.void
          },
        }),
      ),
      Layer.provide(
        Layer.mock(Provider.Service, {
          list: () => Effect.succeed(providers),
        }),
      ),
    )

  const it = testEffect(Layer.empty as Layer.Layer<never>)

  it.effect("discovers only configured providers and refreshes built-ins", () =>
    Effect.gen(function* () {
      const fetchImpl = stubFetch((url) => {
        if (url.includes("opencode.ai")) return jsonResponse(goFixture)
        if (url.includes("openrouter")) return jsonResponse(openRouterFixture)
        return jsonResponse({}, 404)
      })
      const layer = serviceLayer(
        { opencode: authApi("go-key"), openrouter: authApi("or-key") },
        {
          opencode: providerInfo("opencode", "OpenCode Go"),
          openrouter: providerInfo("openrouter", "OpenRouter"),
        },
        fetchImpl,
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh()),
        Effect.provide(layer),
      )
      expect(snapshots.map((s) => s.providerID).sort()).toEqual(["opencode-go", "openrouter"])
      expect(snapshots.every((s) => s.status === "available")).toBe(true)
      expect(snapshots.find((s) => s.providerID === "opencode-go")?.displayName).toBe("OpenCode")
      // No credentials leak into snapshots.
      expect(JSON.stringify(snapshots)).not.toContain("go-key")
      expect(JSON.stringify(snapshots)).not.toContain("or-key")
    }),
  )

  it.effect("one failing provider does not block others", () =>
    Effect.gen(function* () {
      const fetchImpl = stubFetch((url) => {
        if (url.includes("opencode.ai")) return jsonResponse(goFixture)
        return new Response("boom", { status: 500 })
      })
      const layer = serviceLayer(
        { opencode: authApi("go-key"), openrouter: authApi("or-key") },
        {
          opencode: providerInfo("opencode", "OpenCode Go"),
          openrouter: providerInfo("openrouter", "OpenRouter"),
        },
        fetchImpl,
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh()),
        Effect.provide(layer),
      )
      const byId = Object.fromEntries(snapshots.map((s) => [s.providerID, s]))
      expect(byId["opencode-go"].status).toBe("available")
      expect(byId["openrouter"].status).toBe("error")
    }),
  )

  it.effect("unsupported and unauthenticated providers stay represented", () =>
    Effect.gen(function* () {
      const layer = serviceLayer(
        {},
        {
          gemini: providerInfo("gemini", "Gemini"),
          opencode: providerInfo("opencode", "OpenCode Go"),
        },
        stubFetch(() => jsonResponse(goFixture)),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh()),
        Effect.provide(layer),
      )
      const byId = Object.fromEntries(snapshots.map((s) => [s.providerID, s]))
      expect(byId["gemini"].status).toBe("unsupported")
      expect(byId["opencode-go"].status).toBe("unauthenticated")
      expect(byId["opencode-go"].displayName).toBe("OpenCode")
    }),
  )

  const codexJwt = (payload: object): string => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
    return `${header}.${body}.sig`
  }

  it.effect("expired codex OAuth refreshes once before usage and persists", () =>
    Effect.gen(function* () {
      const persisted: Array<{ providerID: string; info: Auth.Info }> = []
      let tokenRequests = 0
      const seen: Array<{ authorization: string | null; accountId: string | null }> = []
      const fetchImpl = stubFetch((url, init) => {
        if (url.includes("/oauth/token")) {
          tokenRequests += 1
          const body = typeof init?.body === "string" ? init.body : ""
          expect(body).toContain("grant_type=refresh_token")
          expect(body).toContain("refresh_token=refresh-token")
          return jsonResponse({
            id_token: codexJwt({ chatgpt_account_id: "acc-refreshed" }),
            access_token: "<access-new>",
            refresh_token: "<refresh-new>",
            expires_in: 3600,
          })
        }
        const headers = new Headers(init?.headers)
        seen.push({
          authorization: headers.get("authorization"),
          accountId: headers.get("ChatGPT-Account-Id"),
        })
        return jsonResponse(codexFixture)
      })
      const layer = serviceLayer(
        { openai: oauth("stale-access", Date.now() - 1_000, "acc-1") },
        { openai: providerInfo("openai", "ChatGPT") },
        fetchImpl,
        (providerID, info) => persisted.push({ providerID, info }),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("openai")),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].status).toBe("available")
      expect(snapshots[0].windows).toHaveLength(3)
      // Exactly one refresh before the single usage call.
      expect(tokenRequests).toBe(1)
      expect(seen).toHaveLength(1)
      // New bearer and refreshed account id travel with the usage call.
      expect(seen[0].authorization).toBe("Bearer <access-new>")
      expect(seen[0].accountId).toBe("acc-refreshed")
      // Persisted via Auth.Service with rotated credentials and account id.
      expect(persisted).toHaveLength(1)
      expect(persisted[0].providerID).toBe("openai")
      const saved = persisted[0].info
      expect(saved.type).toBe("oauth")
      if (saved.type === "oauth") {
        expect(saved.access).toBe("<access-new>")
        expect(saved.refresh).toBe("<refresh-new>")
        expect(saved.accountId).toBe("acc-refreshed")
        expect(saved.expires).toBeGreaterThan(Date.now())
      }
      expect(JSON.stringify(snapshots[0])).not.toContain("stale-access")
    }),
  )

  it.effect("expired codex OAuth keeps the previous account id when tokens carry none", () =>
    Effect.gen(function* () {
      const seen: Array<string | null> = []
      const fetchImpl = stubFetch((url, init) => {
        if (url.includes("/oauth/token")) {
          return jsonResponse({
            id_token: codexJwt({ email: "noid@example.com" }),
            access_token: codexJwt({ email: "noid@example.com" }),
            refresh_token: "<refresh-new>",
            expires_in: 3600,
          })
        }
        seen.push(new Headers(init?.headers).get("ChatGPT-Account-Id"))
        return jsonResponse(codexFixture)
      })
      const layer = serviceLayer(
        { openai: oauth("stale-access", Date.now() - 1_000, "acc-keep") },
        { openai: providerInfo("openai", "ChatGPT") },
        fetchImpl,
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("openai")),
        Effect.provide(layer),
      )
      expect(snapshots[0].status).toBe("available")
      expect(seen).toEqual(["acc-keep"])
    }),
  )

  it.effect("codex 401 refreshes and retries exactly once", () =>
    Effect.gen(function* () {
      let tokenRequests = 0
      let usageRequests = 0
      const seen: Array<string | null> = []
      const fetchImpl = stubFetch((url, init) => {
        if (url.includes("/oauth/token")) {
          tokenRequests += 1
          return jsonResponse({
            id_token: codexJwt({ chatgpt_account_id: "acc-retry" }),
            access_token: "<access-retry>",
            refresh_token: "<refresh-retry>",
            expires_in: 3600,
          })
        }
        usageRequests += 1
        seen.push(new Headers(init?.headers).get("authorization"))
        if (usageRequests === 1) return new Response("unauthorized", { status: 401 })
        return jsonResponse(codexFixture)
      })
      const layer = serviceLayer(
        { openai: oauth("<access-valid>", Date.now() + 3_600_000, "acc-1") },
        { openai: providerInfo("openai", "ChatGPT") },
        fetchImpl,
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("openai")),
        Effect.provide(layer),
      )
      expect(snapshots[0].status).toBe("available")
      expect(tokenRequests).toBe(1)
      expect(usageRequests).toBe(2)
      expect(seen).toEqual(["Bearer <access-valid>", "Bearer <access-retry>"])
    }),
  )

  it.effect("codex 401 after refresh stays unauthenticated without further retries", () =>
    Effect.gen(function* () {
      let tokenRequests = 0
      let usageRequests = 0
      const fetchImpl = stubFetch((url) => {
        if (url.includes("/oauth/token")) {
          tokenRequests += 1
          return jsonResponse({
            id_token: codexJwt({ chatgpt_account_id: "acc-retry" }),
            access_token: "<access-retry>",
            refresh_token: "<refresh-retry>",
            expires_in: 3600,
          })
        }
        usageRequests += 1
        return new Response("unauthorized", { status: 401 })
      })
      const layer = serviceLayer(
        { openai: oauth("<access-valid>", Date.now() + 3_600_000, "acc-1") },
        { openai: providerInfo("openai", "ChatGPT") },
        fetchImpl,
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("openai")),
        Effect.provide(layer),
      )
      expect(snapshots[0].status).toBe("unauthenticated")
      expect(tokenRequests).toBe(1)
      expect(usageRequests).toBe(2)
    }),
  )

  it.effect("codex 403 and 429 are never retried", () =>
    Effect.gen(function* () {
      for (const status of [403, 429]) {
        let tokenRequests = 0
        let usageRequests = 0
        const fetchImpl = stubFetch((url) => {
          if (url.includes("/oauth/token")) {
            tokenRequests += 1
            return jsonResponse({})
          }
          usageRequests += 1
          return new Response("rejected", { status })
        })
        const layer = serviceLayer(
          { openai: oauth("<access-valid>", Date.now() + 3_600_000, "acc-1") },
          { openai: providerInfo("openai", "ChatGPT") },
          fetchImpl,
        )
        const snapshots = yield* ProviderUsage.Service.pipe(
          Effect.flatMap((service) => service.refresh("openai")),
          Effect.provide(layer),
        )
        expect(snapshots[0].status).toBe(status === 403 ? "unauthenticated" : "error")
        expect(tokenRequests).toBe(0)
        expect(usageRequests).toBe(1)
      }
    }),
  )

  it.effect("failed codex refresh redacts secrets", () =>
    Effect.gen(function* () {
      const secret = "sk-secret-xyz-123"
      const fetchImpl = stubFetch((url) => {
        if (url.includes("/oauth/token")) throw new Error(`upstream said Bearer ${secret}`)
        return jsonResponse(codexFixture)
      })
      const layer = serviceLayer(
        { openai: oauth("stale-access", Date.now() - 1_000, "acc-1") },
        { openai: providerInfo("openai", "ChatGPT") },
        fetchImpl,
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("openai")),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].status).toBe("unauthenticated")
      const serialized = JSON.stringify(snapshots)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain("stale-access")
      expect(serialized).not.toContain("refresh-token")
    }),
  )

  it.effect("failed refresh preserves last success as stale", () =>
    Effect.gen(function* () {
      let fail = false
      const fetchImpl = stubFetch(() => (fail ? new Response("boom", { status: 500 }) : jsonResponse(goFixture)))
      const layer = serviceLayer(
        { opencode: authApi("go-key") },
        { opencode: providerInfo("opencode", "OpenCode Go") },
        fetchImpl,
      )
      // One provisioned layer: both refreshes share the same cache.
      const program = Effect.gen(function* () {
        const svc = yield* ProviderUsage.Service
        const first = yield* svc.refresh("opencode")
        expect(first[0].status).toBe("available")
        fail = true
        yield* TestClock.adjust("61 seconds")
        return yield* svc.refresh("opencode")
      })
      const second = yield* Effect.provide(program, layer)
      expect(second[0].status).toBe("stale")
      expect(second[0].windows).toHaveLength(3)
    }),
  )

  it.effect("raw upstream failures are secret-safe", () =>
    Effect.gen(function* () {
      ProviderUsage.registerUsageAdapter({
        id: "leaky",
        providerID: "leaky-provider",
        refreshIntervalSeconds: 60,
        supports: (input) => input.providerID === "leaky-provider",
        fetch: () => Effect.die(new Error("upstream said Bearer sk-secret-123")),
      })
      const layer = serviceLayer(
        { "leaky-provider": authApi("leaky-key") },
        { "leaky-provider": providerInfo("leaky-provider", "Leaky") },
        stubFetch(() => jsonResponse({})),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("leaky-provider")),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(JSON.stringify(snapshots)).not.toContain("sk-secret-123")
      expect(JSON.stringify(snapshots)).not.toContain("leaky-key")
    }),
  )

  test("account switches do not share cache entries", () => {
    expect(ProviderUsage.accountKeyFor(authApi("key-a"))).not.toBe(ProviderUsage.accountKeyFor(authApi("key-b")))
    expect(ProviderUsage.accountKeyFor(authApi("key-a"))).toBe(ProviderUsage.accountKeyFor(authApi("key-a")))
    expect(ProviderUsage.accountKeyFor(oauth("a", Date.now() + 1_000, "acc-1"))).toBe("oauth:acc-1")
    expect(ProviderUsage.accountKeyFor(undefined)).toBe("none")
  })

  it.effect("custom adapters register without central changes; duplicate ids replace", () =>
    Effect.gen(function* () {
      let calls = 0
      ProviderUsage.registerUsageAdapter({
        id: "custom",
        providerID: "custom-provider",
        refreshIntervalSeconds: 60,
        supports: (input) => input.providerID === "custom-provider",
        fetch: (ctx) => {
          calls += 1
          return Effect.succeed(
            new Banyan.ProviderUsageSnapshot({
              providerID: ctx.providerID,
              displayName: ctx.displayName,
              status: "available",
              confidence: "estimated",
              windows: [],
              fetchedAt: Date.now(),
            }),
          )
        },
      })
      ProviderUsage.registerUsageAdapter({
        id: "custom",
        providerID: "custom-provider",
        refreshIntervalSeconds: 60,
        supports: (input) => input.providerID === "custom-provider",
        fetch: (ctx) =>
          Effect.succeed(
            new Banyan.ProviderUsageSnapshot({
              providerID: ctx.providerID,
              displayName: ctx.displayName,
              status: "available",
              confidence: "estimated",
              windows: [],
              fetchedAt: Date.now(),
            }),
          ),
      })
      expect(ProviderUsage.listAdapters().filter((a) => a.id === "custom")).toHaveLength(1)
      const layer = serviceLayer(
        {},
        { "custom-provider": providerInfo("custom-provider", "Custom") },
        stubFetch(() => jsonResponse({})),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("custom-provider")),
        Effect.provide(layer),
      )
      expect(snapshots[0].status).toBe("available")
      expect(snapshots[0].confidence).toBe("estimated")
      expect(calls).toBe(0)
    }),
  )

  it.effect("rate-limited refresh backs off until reset", () =>
    Effect.gen(function* () {
      let calls = 0
      ProviderUsage.registerUsageAdapter({
        id: "throttled",
        providerID: "throttled-provider",
        refreshIntervalSeconds: 60,
        supports: (input) => input.providerID === "throttled-provider",
        fetch: (ctx) => {
          calls += 1
          return new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "rate_limited",
            message: "slow down",
            retryAfterMs: 300_000,
          })
        },
      })
      const layer = serviceLayer(
        { "throttled-provider": authApi("k") },
        { "throttled-provider": providerInfo("throttled-provider", "Throttled") },
        stubFetch(() => jsonResponse({})),
      )
      // One provisioned layer: the backoff marker survives across refreshes.
      const program = Effect.gen(function* () {
        const svc = yield* ProviderUsage.Service
        const first = yield* svc.refresh("throttled-provider")
        expect(first[0].status).toBe("error")
        const second = yield* svc.refresh("throttled-provider")
        expect(second[0].status).toBe("error")
      })
      yield* Effect.provide(program, layer)
      expect(calls).toBe(1)
    }),
  )
})

describe("ProviderUsage.Service without instance context", () => {
  beforeEach(() => {
    ProviderUsage.resetUsageAdapters()
  })

  // Mirrors the real Provider.list failure on /global/* routes, which run
  // without InstanceContextMiddleware: InstanceState dies on the missing
  // InstanceRef. Discovery must keep auth-derived targets instead of
  // collapsing to an empty list (which the TUI backfills as unsupported).
  const noInstanceLayer = (auths: Record<string, Auth.Info>, fetchImpl: FetchImpl) =>
    ProviderUsage.layerWithOptions({ fetchImpl }).pipe(
      Layer.provide(
        Layer.mock(Auth.Service, {
          all: () => Effect.succeed(auths),
        }),
      ),
      Layer.provide(
        Layer.mock(Provider.Service, {
          list: () => Effect.die(new Error("InstanceRef not provided")),
        }),
      ),
    )

  const it = testEffect(Layer.empty as Layer.Layer<never>)

  it.effect("auth-backed opencode-go and openai OAuth stay available when Provider.list dies", () =>
    Effect.gen(function* () {
      const fetchImpl = stubFetch((url) => {
        if (url.includes("opencode.ai")) return jsonResponse(goFixture)
        if (url.includes("chatgpt.com")) return jsonResponse(codexFixture)
        return jsonResponse({}, 404)
      })
      const layer = noInstanceLayer(
        {
          "opencode-go": authApi("go-key"),
          openai: oauth("<access-valid>", Date.now() + 3_600_000, "acc-1"),
        },
        fetchImpl,
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh()),
        Effect.provide(layer),
      )
      const byId = Object.fromEntries(snapshots.map((s) => [s.providerID, s]))
      expect(Object.keys(byId).sort()).toEqual(["openai", "opencode-go"])
      expect(byId["opencode-go"].status).toBe("available")
      expect(byId["opencode-go"].windows).toHaveLength(3)
      expect(byId["openai"].status).toBe("available")
      expect(byId["openai"].windows.length).toBeGreaterThan(0)
      const serialized = JSON.stringify(snapshots)
      expect(serialized).not.toContain("go-key")
      expect(serialized).not.toContain("<access-valid>")
    }),
  )

  it.effect("a dying Auth.all still leaves provider-configured targets discoverable", () =>
    Effect.gen(function* () {
      const fetchImpl = stubFetch((url) => {
        if (url.includes("opencode.ai")) return jsonResponse(goFixture)
        return jsonResponse({}, 404)
      })
      const layer = ProviderUsage.layerWithOptions({ fetchImpl }).pipe(
        Layer.provide(
          Layer.mock(Auth.Service, {
            all: () => Effect.die(new Error("auth store unavailable")),
          }),
        ),
        Layer.provide(
          Layer.mock(Provider.Service, {
            list: () =>
              Effect.succeed({
                opencode: providerInfo("opencode", "OpenCode Go"),
              }),
          }),
        ),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh()),
        Effect.provide(layer),
      )
      // No credentials anywhere: the Go adapter reports unauthenticated
      // instead of dropping the configured provider.
      expect(snapshots.map((s) => s.providerID)).toEqual(["opencode-go"])
      expect(snapshots[0].status).toBe("unauthenticated")
      expect(snapshots[0].displayName).toBe("OpenCode")
    }),
  )
})

describe("ProviderUsage canonicalization", () => {
  test("opencode aliases canonicalize to one ID and label", () => {
    expect(ProviderUsage.canonicalProviderID("opencode")).toBe("opencode-go")
    expect(ProviderUsage.canonicalProviderID("opencode-go")).toBe("opencode-go")
    expect(ProviderUsage.canonicalProviderID("openai")).toBe("openai")
    expect(ProviderUsage.canonicalDisplayName("opencode", "OpenCode Go")).toBe("OpenCode")
    expect(ProviderUsage.canonicalDisplayName("opencode-go", "opencode-go")).toBe("OpenCode")
    expect(ProviderUsage.matchesProviderID("opencode-go", "opencode")).toBe(true)
    expect(ProviderUsage.matchesProviderID("opencode-go", "openai")).toBe(false)
  })

  test("codex OAuth displays ChatGPT, API-key displays OpenAI", () => {
    expect(ProviderUsage.canonicalDisplayName("openai", "OpenAI", "oauth")).toBe("ChatGPT")
    expect(ProviderUsage.canonicalDisplayName("openai", "openai", "api")).toBe("OpenAI")
    expect(ProviderUsage.canonicalDisplayName("openai", "openai", undefined)).toBe("OpenAI")
    expect(ProviderUsage.canonicalDisplayName("openai-codex", "x", "oauth")).toBe("ChatGPT")
  })

  test("custom names preserved, built-in fallbacks never raw lowercase", () => {
    expect(ProviderUsage.canonicalDisplayName("custom-proxy", "My Proxy", "api")).toBe("My Proxy")
    expect(ProviderUsage.canonicalDisplayName("anthropic", "anthropic", "oauth")).toBe("Anthropic")
    expect(ProviderUsage.canonicalDisplayName("openrouter", "openrouter", "api")).toBe("OpenRouter")
    expect(ProviderUsage.canonicalDisplayName("gemini", "gemini", undefined)).toBe("Gemini")
  })

  const aliasIt = testEffect(Layer.empty as Layer.Layer<never>)

  aliasIt.effect("opencode + opencode-go auths dedupe to one OpenCode snapshot", () =>
    Effect.gen(function* () {
      const fetchImpl = stubFetch((url) => {
        if (url.includes("opencode.ai")) return jsonResponse(goFixture)
        return jsonResponse({}, 404)
      })
      const layer = ProviderUsage.layerWithOptions({ fetchImpl }).pipe(
        Layer.provide(
          Layer.mock(Auth.Service, {
            all: () => Effect.succeed({ opencode: authApi("key-a"), "opencode-go": authApi("key-a") }),
            set: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.mock(Provider.Service, {
            list: () =>
              Effect.succeed({
                opencode: providerInfo("opencode", "opencode"),
                "opencode-go": providerInfo("opencode-go", "opencode-go"),
              }),
          }),
        ),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh()),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].providerID).toBe("opencode-go")
      expect(snapshots[0].displayName).toBe("OpenCode")
      // Alias-aware refresh: requesting either alias refreshes the canonical target.
      const viaAlias = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("opencode")),
        Effect.provide(layer),
      )
      expect(viaAlias).toHaveLength(1)
      expect(viaAlias[0].providerID).toBe("opencode-go")
    }),
  )

  aliasIt.effect("opencode-go auth and options win regardless of insertion order", () =>
    Effect.gen(function* () {
      // The Go adapter prefers OPENCODE_API_KEY over every other leg, so
      // the env must be empty to observe the config/auth precedence below.
      const previousEnv = process.env.OPENCODE_API_KEY
      delete process.env.OPENCODE_API_KEY
      try {
        const seenAuth: Array<string | null> = []
        const fetchImpl = stubFetch((url, init) => {
          if (url.includes("opencode.ai")) {
            seenAuth.push(new Headers(init?.headers).get("authorization"))
            return jsonResponse(goFixture)
          }
          return jsonResponse({}, 404)
        })
        const buildLayer = (auths: Record<string, Auth.Info>, providers: Record<string, Provider.Info>) =>
          ProviderUsage.layerWithOptions({ fetchImpl }).pipe(
            Layer.provide(
              Layer.mock(Auth.Service, {
                all: () => Effect.succeed(auths),
                set: () => Effect.void,
              }),
            ),
            Layer.provide(
              Layer.mock(Provider.Service, {
                list: () => Effect.succeed(providers),
              }),
            ),
          )
        // Distinct auth keys: the canonical opencode-go credential must reach
        // the adapter whichever alias was inserted first.
        for (const legacyFirst of [false, true]) {
          const entries: Array<[string, Auth.Info]> = legacyFirst
            ? [
                ["opencode", authApi("key-legacy")],
                ["opencode-go", authApi("key-canonical")],
              ]
            : [
                ["opencode-go", authApi("key-canonical")],
                ["opencode", authApi("key-legacy")],
              ]
          seenAuth.length = 0
          const snapshots = yield* ProviderUsage.Service.pipe(
            Effect.flatMap((service) => service.refresh()),
            Effect.provide(
              buildLayer(Object.fromEntries(entries), {
                opencode: providerInfo("opencode", "opencode"),
                "opencode-go": providerInfo("opencode-go", "opencode-go"),
              }),
            ),
          )
          expect(snapshots).toHaveLength(1)
          expect(snapshots[0].providerID).toBe("opencode-go")
          expect(seenAuth).toEqual(["Bearer key-canonical"])
        }
        // Distinct config keys without stored auth: the canonical opencode-go
        // options.apiKey must win over the legacy leg.
        for (const legacyFirst of [false, true]) {
          const entries: Array<[string, Provider.Info]> = legacyFirst
            ? [
                ["opencode", { ...providerInfo("opencode", "opencode"), options: { apiKey: "opt-legacy" } }],
                [
                  "opencode-go",
                  { ...providerInfo("opencode-go", "opencode-go"), options: { apiKey: "opt-canonical" } },
                ],
              ]
            : [
                [
                  "opencode-go",
                  { ...providerInfo("opencode-go", "opencode-go"), options: { apiKey: "opt-canonical" } },
                ],
                ["opencode", { ...providerInfo("opencode", "opencode"), options: { apiKey: "opt-legacy" } }],
              ]
          seenAuth.length = 0
          const snapshots = yield* ProviderUsage.Service.pipe(
            Effect.flatMap((service) => service.refresh()),
            Effect.provide(buildLayer({}, Object.fromEntries(entries))),
          )
          expect(snapshots).toHaveLength(1)
          expect(snapshots[0].providerID).toBe("opencode-go")
          expect(snapshots[0].status).toBe("available")
          expect(seenAuth).toEqual(["Bearer opt-canonical"])
        }
      } finally {
        if (previousEnv === undefined) delete process.env.OPENCODE_API_KEY
        else process.env.OPENCODE_API_KEY = previousEnv
      }
    }),
  )

  aliasIt.effect("accountKey tracks the actually-sent env/config key", () =>
    Effect.gen(function* () {
      const previousEnv = process.env.OPENCODE_API_KEY
      const seenAuth: Array<string | null> = []
      let fetches = 0
      const fetchImpl = stubFetch((url, init) => {
        if (url.includes("opencode.ai")) {
          fetches += 1
          seenAuth.push(new Headers(init?.headers).get("authorization"))
          return jsonResponse(goFixture)
        }
        return jsonResponse({}, 404)
      })
      const providerInfos: Record<string, Provider.Info> = {
        opencode: providerInfo("opencode", "opencode"),
        "opencode-go": providerInfo("opencode-go", "opencode-go"),
      }
      const layer = ProviderUsage.layerWithOptions({ fetchImpl }).pipe(
        Layer.provide(
          Layer.mock(Auth.Service, {
            all: () => Effect.succeed({ opencode: authApi("key-stored"), "opencode-go": authApi("key-stored") }),
            set: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.mock(Provider.Service, {
            list: () => Effect.succeed(providerInfos),
          }),
        ),
      )
      const expectSingleAvailable = (list: Banyan.ProviderUsageSnapshot[]) => {
        expect(list).toHaveLength(1)
        expect(list[0].providerID).toBe("opencode-go")
        expect(list[0].displayName).toBe("OpenCode")
        expect(list[0].status).toBe("available")
      }
      try {
        // One provisioned layer: every snapshots() call below shares the
        // same cache, so a repeat fetch proves a cache miss (accountKey
        // change) rather than a fresh service.
        const program = Effect.gen(function* () {
          const svc = yield* ProviderUsage.Service
          // Env beats stored auth; a repeat call hits the same accountKey.
          process.env.OPENCODE_API_KEY = "env-key-1"
          expectSingleAvailable(yield* svc.snapshots())
          expect(fetches).toBe(1)
          expect(seenAuth).toEqual(["Bearer env-key-1"])
          expectSingleAvailable(yield* svc.snapshots())
          expect(fetches).toBe(1)
          // Rotating only the env key (stored auth unchanged) misses the
          // cache, proving the accountKey follows the actually-sent credential.
          process.env.OPENCODE_API_KEY = "env-key-2"
          expectSingleAvailable(yield* svc.snapshots())
          expect(fetches).toBe(2)
          expect(seenAuth).toEqual(["Bearer env-key-1", "Bearer env-key-2"])
          // Dropping env falls back to the canonical config key.
          delete process.env.OPENCODE_API_KEY
          providerInfos["opencode-go"] = {
            ...providerInfo("opencode-go", "opencode-go"),
            options: { apiKey: "opt-1" },
          }
          expectSingleAvailable(yield* svc.snapshots())
          expect(fetches).toBe(3)
          expect(seenAuth[seenAuth.length - 1]).toBe("Bearer opt-1")
          expectSingleAvailable(yield* svc.snapshots())
          expect(fetches).toBe(3)
          // Rotating only the config key (stored auth unchanged) misses the cache.
          providerInfos["opencode-go"] = {
            ...providerInfo("opencode-go", "opencode-go"),
            options: { apiKey: "opt-2" },
          }
          expectSingleAvailable(yield* svc.snapshots())
          expect(fetches).toBe(4)
          expect(seenAuth[seenAuth.length - 1]).toBe("Bearer opt-2")
          // Dropping the config key falls back to stored auth.
          providerInfos["opencode-go"] = providerInfo("opencode-go", "opencode-go")
          expectSingleAvailable(yield* svc.snapshots())
          expect(fetches).toBe(5)
          expect(seenAuth[seenAuth.length - 1]).toBe("Bearer key-stored")
        })
        yield* Effect.provide(program, layer)
      } finally {
        if (previousEnv === undefined) delete process.env.OPENCODE_API_KEY
        else process.env.OPENCODE_API_KEY = previousEnv
      }
    }),
  )
})
