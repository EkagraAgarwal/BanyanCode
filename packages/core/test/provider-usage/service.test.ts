import { afterEach, describe, expect, test } from "bun:test"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { ProviderUsage } from "@opencode/core/provider-usage/index"
import type { Target } from "@opencode/core/provider-usage/index"
import { Effect, Layer } from "effect"
import type { Endpoints } from "@opencode/core/provider-usage/index"
import { Provider } from "@opencode/core/provider"
import { IntegrationConnection } from "@opencode/core/integration/connection"

const servers: Array<{ stop: (force?: boolean) => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const serve = (handler: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ port: 0, fetch: handler })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

/** Every endpoint points at the local fake server; adapters still use fixed paths. */
const endpointsFor = (base: string): Endpoints => ({
  anthropic: `${base}/api/oauth/usage`,
  chatgpt: `${base}/backend-api/wham/usage`,
  openrouter: `${base}/api/v1/key`,
  githubCopilot: `${base}/copilot_internal/user`,
  kimi: `${base}/coding/v1/usages`,
  zhipu: `${base}/api/monitor/usage/quota/limit`,
  zhipuIntl: `${base}/intl/api/monitor/usage/quota/limit`,
  minimax: `${base}/v1/api/openplatform/coding_plan/remains`,
  minimaxIntl: `${base}/intl/v1/api/openplatform/coding_plan/remains`,
  opencodeGo: `${base}/zen/go/v1/usage`,
})

const oauth = (token: string) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("fixture"),
    access: token,
    refresh: `refresh-${token}`,
    expires: Date.now() + 60_000,
  })

const key = (secret: string) => Credential.Key.make({ type: "key", key: secret })

const target = (input: {
  readonly providerID: string
  readonly displayName?: string
  readonly hasAuth?: boolean
  readonly authType?: string
  readonly accountKey?: string
  readonly credential?: Credential.Value
}): Target => ({
  providerID: input.providerID,
  displayName: input.displayName ?? input.providerID,
  hasAuth: input.hasAuth ?? true,
  ...(input.authType === undefined ? {} : { authType: input.authType }),
  accountKey: input.accountKey ?? "credential:cred_fixture",
  credential: () => Effect.succeed(input.credential),
})

const snapshots = (targets: ReadonlyArray<Target>, options: ProviderUsage.Options = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const usage = yield* ProviderUsage.make({ targets: () => Effect.succeed(targets), ...options })
      return yield* usage.snapshots()
    }),
  )

describe("provider usage adapters", () => {
  test("anthropic OAuth windows normalize from the pinned endpoint", async () => {
    const requests: Array<string | undefined> = []
    const base = serve((request) => {
      requests.push(request.headers.get("authorization") ?? undefined)
      return Response.json({
        five_hour: { utilization: 0.42, resets_at: "2026-11-01T12:00:00Z" },
        seven_day: { utilization: 80, resets_at: "2026-11-08T12:00:00Z" },
      })
    })
    const token = "access-token-anthropic"
    const result = await snapshots(
      [
        target({
          providerID: "anthropic",
          displayName: "Anthropic",
          authType: "oauth",
          credential: oauth(token),
        }),
      ],
      { endpoints: endpointsFor(base) },
    )
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("available")
    expect(snapshot.confidence).toBe("exact")
    expect(snapshot.windows.map((window) => window.label)).toEqual(["5h", "Weekly"])
    expect(snapshot.windows[0]!.usedPercent).toBe(42)
    expect(snapshot.windows[0]!.remainingPercent).toBe(58)
    expect(snapshot.windows[0]!.durationSeconds).toBe(18_000)
    expect(requests).toEqual([`Bearer ${token}`])
    // The token is used for the request only; it is never part of the result.
    expect(JSON.stringify(result)).not.toContain(token)
  })

  test("an adapter failure message never contains the credential", async () => {
    const secret = "sk-live-TOPSECRET"
    const marker = "sk-live-TOPSECRET"
    const base = serve(() =>
      // A hostile/verbose upstream echoes the key back in its own message.
      Response.json({ success: false, code: 401, msg: `invalid api key ${marker}` }),
    )
    const result = await snapshots([target({ providerID: "zhipu", credential: key(secret) })], {
      endpoints: endpointsFor(base),
    })
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("error")
    expect(snapshot.message).toBeDefined()
    expect(snapshot.message).not.toContain(marker)
    expect(snapshot.message).toContain("[redacted]")
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test("a transport failure that embeds the token is redacted too", async () => {
    const secret = "sk-transport-SECRET"
    const result = await snapshots([target({ providerID: "openrouter", credential: key(secret) })], {
      fetchImpl: () => Promise.reject(new Error(`connect failed for authorization: Bearer ${secret}`)),
    })
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("error")
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test("TTL caching serves the cached row; force refreshes", async () => {
    let calls = 0
    const base = serve(() => {
      calls++
      return Response.json({ data: { limit: 10, usage: 2 } })
    })
    let now = 1_000
    const usage = await Effect.runPromise(
      ProviderUsage.make({
        targets: () =>
          Effect.succeed([target({ providerID: "openrouter", credential: key("sk-openrouter-secret") })]),
        endpoints: endpointsFor(base),
        now: () => now,
      }),
    )
    const first = await Effect.runPromise(usage.snapshots())
    expect(first.snapshots[0]!.status).toBe("available")
    expect(first.snapshots[0]!.balance?.remaining).toBe(8)
    expect(calls).toBe(1)

    now += 1_000
    await Effect.runPromise(usage.snapshots())
    expect(calls).toBe(1)

    await Effect.runPromise(usage.snapshots({ force: true }))
    expect(calls).toBe(2)
  })

  test("a provider without an exact adapter stays unsupported and makes no request", async () => {
    let calls = 0
    const base = serve(() => {
      calls++
      return Response.json({})
    })
    const result = await snapshots([target({ providerID: "ollama", credential: key("local") })], {
      endpoints: endpointsFor(base),
    })
    expect(result.snapshots[0]).toMatchObject({
      status: "unsupported",
      message: "Usage unavailable",
      windows: [],
    })
    expect(calls).toBe(0)
  })

  test("an API-key Anthropic connection resolves to unsupported, not a fabricated quota", async () => {
    const result = await snapshots([target({ providerID: "anthropic", credential: key("sk-ant-api") })], {
      fetchImpl: () => Promise.reject(new Error("must not be called")),
    })
    expect(result.snapshots[0]!.status).toBe("unsupported")
  })

  test("providerID filtering matches the opencode alias group", async () => {
    const base = serve(() => Response.json({ usage: { rolling: { percent: 25 } } }))
    const result = await snapshots(
      [target({ providerID: "opencode-go", displayName: "OpenCode", credential: key("sk-opencode") })],
      { endpoints: endpointsFor(base) },
    )
    const usage = await Effect.runPromise(
      ProviderUsage.make({
        targets: () =>
          Effect.succeed([target({ providerID: "opencode", displayName: "OpenCode", credential: key("sk-opencode") })]),
        endpoints: endpointsFor(base),
      }),
    )
    expect(result.snapshots[0]!.displayName).toBe("OpenCode")
    const filtered = await Effect.runPromise(usage.snapshots({ providerID: "opencode-go" }))
    expect(filtered.snapshots.map((snapshot) => snapshot.providerID)).toEqual(["opencode"])
  })
})

describe("provider usage credential boundary", () => {
  test("the layer resolves the credential inside core and returns only numbers", async () => {
    const token = "sk-layer-SECRET"
    let authorization: string | undefined
    const base = serve((request) => {
      authorization = request.headers.get("authorization") ?? undefined
      return Response.json({ data: { limit: 5, usage: 1 } })
    })
    const provider = { id: "openrouter", name: "OpenRouter", activation: "auto", package: "" } as const
    const connection: IntegrationConnection.Info = {
      type: "credential",
      id: Credential.ID.make("cred_fixture"),
      label: "fixture",
      method: "key",
    }
    const providerService = Layer.succeed(Provider.Service, {
      available: () => Effect.succeed([provider]),
      all: () => Effect.succeed([provider]),
      get: () => Effect.succeed(provider),
      reload: Effect.void,
      transform: () => Effect.never,
      snapshot: () => Effect.never,
    } as unknown as Provider.Interface)
    const integrationService = Layer.succeed(Integration.Service, {
      connection: {
        active: () => Effect.succeed(connection),
        resolve: () => Effect.succeed(key(token)),
        status: () => Effect.void,
      },
    } as unknown as Integration.Interface)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const usage = yield* ProviderUsage.Service
        return yield* usage.snapshots()
      }).pipe(
        Effect.provide(
          ProviderUsage.layerWithOptions({ endpoints: endpointsFor(base) }).pipe(
            Layer.provideMerge(providerService),
            Layer.provide(integrationService),
          ),
        ),
      ),
    )
    expect(authorization).toBe(`Bearer ${token}`)
    expect(result.snapshots[0]!.status).toBe("available")
    expect(JSON.stringify(result)).not.toContain(token)
  })
})
