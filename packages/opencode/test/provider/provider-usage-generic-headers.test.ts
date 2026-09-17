import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ProviderUsage } from "@/provider/usage"
import type { AdapterContext, FetchImpl } from "@/provider/usage"
import {
  GENERIC_RATE_LIMIT_ADAPTER_ID,
  GenericRateLimitAdapter,
} from "@/provider/usage/generic-rate-limit"
import {
  accountKeyForApiKey,
  clearObservations,
  observedCount,
  observeRateLimitResponse,
  pruneObservationsForAccount,
  readObservedRateLimit,
} from "@/provider/usage/observer"
import { wrapObservedFetch } from "@/provider/usage/observed-fetch"
import { normalizeOpenRouterKey } from "@/provider/usage/openrouter"
import { testEffect } from "../lib/effect"

const jsonResponse = (payload: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

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

const providerInfoWithKey = (
  id: string,
  name: string,
  opts: { key?: string; apiKeyOption?: string; source?: Provider.Info["source"] } = {},
): Provider.Info => ({
  id: ProviderV2.ID.make(id),
  name,
  source: opts.source ?? (opts.key !== undefined ? "env" : "config"),
  env: [],
  ...(opts.key !== undefined ? { key: opts.key } : {}),
  options: opts.apiKeyOption !== undefined ? { apiKey: opts.apiKeyOption } : {},
  models: {},
})

const authApi = (key: string): Auth.Info => new Auth.Api({ type: "api", key })

const ctxFor = (
  providerID: string,
  auth: Auth.Info | undefined,
  accountKey: string,
  fetch: FetchImpl,
): AdapterContext => ({
  providerID,
  displayName: providerID,
  auth,
  options: {},
  accountKey,
  fetch,
})

const fetchError = async (ctx: AdapterContext) => Effect.runPromise(Effect.flip(GenericRateLimitAdapter.fetch(ctx)))

describe("generic rate-limit header capture", () => {
  beforeEach(() => {
    clearObservations()
    ProviderUsage.resetUsageAdapters()
  })

  test("observer stores only normalized numeric values, never raw headers or secrets", () => {
    const secret = "sk-live-secret-abc123"
    const ok = observeRateLimitResponse(
      "openai",
      {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "40",
        authorization: `Bearer ${secret}`,
        "x-custom-secret": secret,
      },
      { accountKey: "key:abc" },
    )
    expect(ok).toBe(true)
    const entry = readObservedRateLimit("openai", "key:abc")
    expect(entry).toBeDefined()
    expect(entry!.windows).toHaveLength(1)
    expect(entry!.windows[0].limit).toBe(100)
    expect(entry!.windows[0].remaining).toBe(40)
    expect(JSON.stringify(entry)).not.toContain(secret)
    expect(JSON.stringify(entry)).not.toContain("Bearer")
    expect(JSON.stringify(entry)).not.toContain("x-custom-secret")
  })

  test("wrapped provider fetch captures headers without touching the body", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "hi" } }] })
    const inner = async () =>
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-limit-requests": "500",
          "x-ratelimit-remaining-requests": "499",
        },
      })
    const wrapped = wrapObservedFetch(inner, { providerID: "groq", accountKey: "key:k1" })
    const response = await wrapped("https://api.groq.com/v1/chat", { method: "POST" })
    // Same semantics: status preserved, body fully intact.
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(body)
    const entry = readObservedRateLimit("groq", "key:k1")
    expect(entry).toBeDefined()
    expect(entry!.windows[0].limit).toBe(500)
    expect(entry!.windows[0].remaining).toBe(499)
  })

  test("custom fetch wrappers keep working and rejections propagate untouched", async () => {
    let innerCalls = 0
    const custom = async () => {
      innerCalls += 1
      return jsonResponse({ ok: true }, 200, { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "9" })
    }
    const wrapped = wrapObservedFetch(custom, { providerID: "mistral", accountKey: "key:m1" })
    const res = await wrapped("https://api.mistral.ai/v1", {})
    expect(innerCalls).toBe(1)
    expect(res.status).toBe(200)
    expect(readObservedRateLimit("mistral", "key:m1")).toBeDefined()

    const failing = async () => {
      throw new Error("socket hang up")
    }
    await expect(wrapObservedFetch(failing, { providerID: "mistral", accountKey: "key:m1" })("https://x", {})).rejects.toThrow(
      "socket hang up",
    )
    // Failed calls record nothing new for a provider with no headers.
    expect(readObservedRateLimit("mistral", "key:other")).toBeUndefined()
  })

  test("malformed and reset formats are handled, empty headers record nothing", () => {
    // Non-numeric limit with a valid remaining still yields a window without a limit.
    expect(
      observeRateLimitResponse("xai", { "x-ratelimit-limit-requests": "not-a-number", "x-ratelimit-remaining-requests": "7" }, { accountKey: "key:x" }),
    ).toBe(true)
    const partial = readObservedRateLimit("xai", "key:x")
    expect(partial!.windows[0].limit).toBeUndefined()
    expect(partial!.windows[0].remaining).toBe(7)
    expect(partial!.windows[0].resetsAt).toBeUndefined()

    // Epoch seconds reset normalizes to epoch milliseconds.
    clearObservations()
    expect(
      observeRateLimitResponse(
        "xai",
        {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "10",
          "x-ratelimit-reset-requests": "1786000000",
        },
        { accountKey: "key:x" },
      ),
    ).toBe(true)
    expect(readObservedRateLimit("xai", "key:x")!.windows[0].resetsAt).toBe(1_786_000_000_000)

    // Malformed reset is dropped, window kept.
    clearObservations()
    expect(
      observeRateLimitResponse(
        "xai",
        {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "10",
          "x-ratelimit-reset-requests": "soon",
        },
        { accountKey: "key:x" },
      ),
    ).toBe(true)
    expect(readObservedRateLimit("xai", "key:x")!.windows[0].resetsAt).toBeUndefined()

    // No usable headers: nothing stored.
    clearObservations()
    expect(observeRateLimitResponse("xai", { "content-type": "application/json" }, { accountKey: "key:x" })).toBe(false)
    expect(readObservedRateLimit("xai", "key:x")).toBeUndefined()
    expect(observedCount()).toBe(0)
  })

  test("observations are partitioned by account and pruned on switch", async () => {
    const keyA = ProviderUsage.accountKeyFor(authApi("key-A"))
    const keyB = ProviderUsage.accountKeyFor(authApi("key-B"))
    expect(keyA).not.toBe(keyB)
    expect(keyA).toBe(accountKeyForApiKey("key-A"))

    observeRateLimitResponse(
      "openai",
      { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "90" },
      { accountKey: keyA },
    )
    const fetch = stubFetch(() => jsonResponse({}))
    // Other account sees nothing.
    const errB = await fetchError(ctxFor("openai", authApi("key-B"), keyB, fetch))
    expect(errB.reason).toBe("unsupported")
    // Prune on switch drops the previous account's entry.
    pruneObservationsForAccount("openai", keyB)
    expect(readObservedRateLimit("openai", keyA)).toBeUndefined()
    expect(observedCount()).toBe(0)
  })

  test("stale observations expire and fall back to unsupported", () => {
    const key = ProviderUsage.accountKeyFor(authApi("ttl-key"))
    observeRateLimitResponse(
      "perplexity",
      { "x-ratelimit-limit-requests": "60", "x-ratelimit-remaining-requests": "59" },
      { accountKey: key, now: Date.now() - 120_000 },
    )
    expect(readObservedRateLimit("perplexity", key)).toBeUndefined()
    expect(observedCount()).toBe(0)
  })

  test("generic adapter is last so exact adapters win", () => {
    const ids = ProviderUsage.listAdapters().map((a) => a.id)
    expect(ids[ids.length - 1]).toBe(GENERIC_RATE_LIMIT_ADAPTER_ID)
    expect(GenericRateLimitAdapter.supports({ providerID: "openrouter", hasAuth: true, authType: "api" })).toBe(true)
  })

  test("no observation means unsupported, no credentials means unauthenticated", async () => {
    const fetch = stubFetch(() => jsonResponse({}))
    const unsupported = await fetchError(ctxFor("cerebras", authApi("k"), ProviderUsage.accountKeyFor(authApi("k")), fetch))
    expect(unsupported.reason).toBe("unsupported")

    const unauth = await fetchError(ctxFor("cerebras", undefined, "none", fetch))
    expect(unauth.reason).toBe("unauthenticated")
  })

  test("reported snapshot carries no secrets", async () => {
    const auth = authApi("super-secret-key")
    const key = ProviderUsage.accountKeyFor(auth)
    observeRateLimitResponse(
      "groq",
      { "x-ratelimit-limit-requests": "200", "x-ratelimit-remaining-requests": "150" },
      { accountKey: key },
    )
    const snapshot = await Effect.runPromise(
      GenericRateLimitAdapter.fetch(ctxFor("groq", auth, key, stubFetch(() => jsonResponse({})))),
    )
    expect(snapshot.status).toBe("available")
    expect(snapshot.confidence).toBe("reported")
    expect(snapshot.windows[0].kind).toBe("rate_limit")
    const encoded = JSON.stringify(snapshot)
    expect(encoded).not.toContain("super-secret-key")
    expect(encoded).not.toContain("Bearer")
  })

  const serviceLayer = (
    auths: Record<string, Auth.Info>,
    providers: Record<string, Provider.Info>,
    fetchImpl: FetchImpl,
  ) =>
    ProviderUsage.layerWithOptions({ fetchImpl }).pipe(
      Layer.provide(Layer.mock(Auth.Service, { all: () => Effect.succeed(auths) })),
      Layer.provide(Layer.mock(Provider.Service, { list: () => Effect.succeed(providers) })),
    )

  const it = testEffect(Layer.empty as Layer.Layer<never>)

  it.effect("service shows reported for observed providers and unsupported without observation", () =>
    Effect.gen(function* () {
      const groqAuth = authApi("groq-key")
      const groqKey = ProviderUsage.accountKeyFor(groqAuth)
      observeRateLimitResponse(
        "groq",
        { "x-ratelimit-limit-requests": "200", "x-ratelimit-remaining-requests": "150" },
        { accountKey: groqKey },
      )
      const layer = serviceLayer(
        { groq: groqAuth, gemini: authApi("gemini-key") },
        { groq: providerInfo("groq", "Groq"), gemini: providerInfo("gemini", "Gemini") },
        stubFetch(() => jsonResponse({}, 404)),
      )
      const program = Effect.gen(function* () {
        const svc = yield* ProviderUsage.Service
        return yield* svc.refresh()
      })
      const snapshots = yield* Effect.provide(program, layer)
      const byId = Object.fromEntries(snapshots.map((s) => [s.providerID, s]))
      expect(byId["groq"].status).toBe("available")
      expect(byId["groq"].confidence).toBe("reported")
      expect(byId["gemini"].status).toBe("unsupported")
      expect(JSON.stringify(snapshots)).not.toContain("groq-key")
    }),
  )

  it.effect("exact adapter wins over observed headers for configured providers", () =>
    Effect.gen(function* () {
      const orAuth = authApi("or-key")
      const orKey = ProviderUsage.accountKeyFor(orAuth)
      // Even with observed headers present, OpenRouter serves its exact quota.
      observeRateLimitResponse(
        "openrouter",
        { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "1" },
        { accountKey: orKey },
      )
      const layer = serviceLayer(
        { openrouter: orAuth },
        { openrouter: providerInfo("openrouter", "OpenRouter") },
        stubFetch(() => jsonResponse({ data: { limit: 100, usage: 25 } })),
      )
      const program = Effect.gen(function* () {
        const svc = yield* ProviderUsage.Service
        return yield* svc.refresh("openrouter")
      })
      const snapshots = yield* Effect.provide(program, layer)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].confidence).toBe("exact")
      // Sanity: the pure exact normalizer agrees.
      const exact = normalizeOpenRouterKey({ data: { limit: 100, usage: 25 } }, { providerID: "openrouter", displayName: "OpenRouter" })
      expect(snapshots[0].windows[0].remaining).toBe(exact.windows[0].remaining)
    }),
  )

  it.effect("account switch invalidates the previous account's reported snapshot", () =>
    Effect.gen(function* () {
      const authA = authApi("switch-A")
      const keyA = ProviderUsage.accountKeyFor(authA)
      observeRateLimitResponse(
        "xai",
        { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "80" },
        { accountKey: keyA },
      )
      const auths: Record<string, Auth.Info> = { xai: authA }
      const providers = { xai: providerInfo("xai", "xAI") }
      const layer = serviceLayer(auths, providers, stubFetch(() => jsonResponse({}, 404)))
      const program = Effect.gen(function* () {
        const svc = yield* ProviderUsage.Service
        const first = yield* svc.refresh("xai")
        expect(first[0].status).toBe("available")
        expect(first[0].confidence).toBe("reported")
        // Switch account: same provider id, different key.
        auths["xai"] = authApi("switch-B")
        const second = yield* svc.refresh("xai")
        return second
      })
      const second = yield* Effect.provide(program, layer)
      expect(second[0].status).toBe("unsupported")
      const encoded = JSON.stringify(second)
      expect(encoded).not.toContain("switch-A")
      expect(encoded).not.toContain("switch-B")
    }),
  )

  test("Banyan error snapshots stay secret-safe", () => {
    const snapshot = Banyan.errorSnapshot("xai", "xAI", "boom Bearer sk-hidden")
    expect(JSON.stringify(snapshot)).not.toContain("sk-hidden")
  })

  test("discovery fingerprint exactly matches observer capture", () => {
    for (const raw of ["env-key-1", "cfg-key-2", "or-key"]) {
      expect(ProviderUsage.accountKeyFor(authApi(raw))).toBe(accountKeyForApiKey(raw))
    }
    expect(accountKeyForApiKey(undefined)).toBe("unknown")
    expect(ProviderUsage.accountKeyFor(undefined)).toBe("none")
  })

  it.effect("env-key provider with no Auth entry surfaces reported headers", () =>
    Effect.gen(function* () {
      const rawKey = "env-only-key-1"
      observeRateLimitResponse(
        "xai",
        { "x-ratelimit-limit-requests": "300", "x-ratelimit-remaining-requests": "270" },
        { accountKey: accountKeyForApiKey(rawKey) },
      )
      const layer = serviceLayer(
        {},
        { xai: providerInfoWithKey("xai", "xAI", { key: rawKey }) },
        stubFetch(() => jsonResponse({}, 404)),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("xai")),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].status).toBe("available")
      expect(snapshots[0].confidence).toBe("reported")
      expect(snapshots[0].windows[0].limit).toBe(300)
      expect(snapshots[0].windows[0].remaining).toBe(270)
      const encoded = JSON.stringify(snapshots)
      expect(encoded).not.toContain(rawKey)
    }),
  )

  it.effect("config options.apiKey provider with no Auth entry surfaces reported headers", () =>
    Effect.gen(function* () {
      const rawKey = "cfg-only-key-2"
      observeRateLimitResponse(
        "groq",
        { "x-ratelimit-limit-requests": "120", "x-ratelimit-remaining-requests": "100" },
        { accountKey: accountKeyForApiKey(rawKey) },
      )
      const layer = serviceLayer(
        {},
        { groq: providerInfoWithKey("groq", "Groq", { apiKeyOption: rawKey }) },
        stubFetch(() => jsonResponse({}, 404)),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("groq")),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].status).toBe("available")
      expect(snapshots[0].confidence).toBe("reported")
      const encoded = JSON.stringify(snapshots)
      expect(encoded).not.toContain(rawKey)
    }),
  )

  it.effect("config options.apiKey wins over info.key, matching runtime capture", () =>
    Effect.gen(function* () {
      const envKey = "env-key-loses"
      const cfgKey = "cfg-key-wins"
      observeRateLimitResponse(
        "mistral",
        { "x-ratelimit-limit-requests": "50", "x-ratelimit-remaining-requests": "49" },
        { accountKey: accountKeyForApiKey(cfgKey) },
      )
      const providers = { mistral: providerInfoWithKey("mistral", "Mistral", { key: envKey, apiKeyOption: cfgKey }) }
      const layer = serviceLayer({}, providers, stubFetch(() => jsonResponse({}, 404)))
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("mistral")),
        Effect.provide(layer),
      )
      expect(snapshots[0].status).toBe("available")
      expect(snapshots[0].confidence).toBe("reported")
      // The env-key account alone has no observation.
      expect(readObservedRateLimit("mistral", accountKeyForApiKey(envKey))).toBeUndefined()
      const encoded = JSON.stringify(snapshots)
      expect(encoded).not.toContain(envKey)
      expect(encoded).not.toContain(cfgKey)
    }),
  )

  it.effect("env-key rotation partitions observations and leaks no raw key", () =>
    Effect.gen(function* () {
      const keyA = "env-rotate-A"
      const keyB = "env-rotate-B"
      observeRateLimitResponse(
        "cerebras",
        { "x-ratelimit-limit-requests": "80", "x-ratelimit-remaining-requests": "70" },
        { accountKey: accountKeyForApiKey(keyA) },
      )
      const providers: Record<string, Provider.Info> = {
        cerebras: providerInfoWithKey("cerebras", "Cerebras", { key: keyA }),
      }
      const layer = serviceLayer({}, providers, stubFetch(() => jsonResponse({}, 404)))
      const program = Effect.gen(function* () {
        const svc = yield* ProviderUsage.Service
        const first = yield* svc.refresh("cerebras")
        expect(first[0].status).toBe("available")
        expect(first[0].confidence).toBe("reported")
        // Rotate the environment key: same provider id, new credential.
        providers["cerebras"] = providerInfoWithKey("cerebras", "Cerebras", { key: keyB })
        return yield* svc.refresh("cerebras")
      })
      const second = yield* Effect.provide(program, layer)
      expect(second[0].status).toBe("unsupported")
      const encoded = JSON.stringify(second)
      expect(encoded).not.toContain(keyA)
      expect(encoded).not.toContain(keyB)
    }),
  )

  it.effect("env-key provider with no observation stays unsupported without leaking the key", () =>
    Effect.gen(function* () {
      const rawKey = "env-quiet-key-9"
      const layer = serviceLayer(
        {},
        { perplexity: providerInfoWithKey("perplexity", "Perplexity", { key: rawKey }) },
        stubFetch(() => jsonResponse({}, 404)),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("perplexity")),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].status).toBe("unsupported")
      expect(JSON.stringify(snapshots)).not.toContain(rawKey)
    }),
  )

  it.effect("exact adapter still wins for env-key providers with observed headers", () =>
    Effect.gen(function* () {
      const rawKey = "env-or-key-3"
      observeRateLimitResponse(
        "openrouter",
        { "x-ratelimit-limit-requests": "10", "x-ratelimit-remaining-requests": "1" },
        { accountKey: accountKeyForApiKey(rawKey) },
      )
      const layer = serviceLayer(
        {},
        { openrouter: providerInfoWithKey("openrouter", "OpenRouter", { apiKeyOption: rawKey }) },
        stubFetch(() => jsonResponse({ data: { limit: 100, usage: 25 } })),
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh("openrouter")),
        Effect.provide(layer),
      )
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0].status).toBe("available")
      expect(snapshots[0].confidence).toBe("exact")
      expect(JSON.stringify(snapshots)).not.toContain(rawKey)
    }),
  )
})
