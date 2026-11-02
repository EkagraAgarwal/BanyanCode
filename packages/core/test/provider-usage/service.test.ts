import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { ProviderUsage } from "@opencode/core/provider-usage/index"
import type { Target } from "@opencode/core/provider-usage/index"
import { Effect, Layer } from "effect"
import type { Endpoints } from "@opencode/core/provider-usage/index"
import { Provider } from "@opencode/core/provider"
import { IntegrationConnection } from "@opencode/core/integration/connection"
import { ClaudeRateLimits } from "@opencode/core/plugin/provider/claude-agent/claude/rate-limits"
import { ConvertClaudeStream } from "@opencode/core/plugin/provider/claude-agent/language-model/convert-claude-stream"

const servers: Array<{ stop: (force?: boolean) => void }> = []
let store = ""

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  ClaudeRateLimits.reset()
  ClaudeRateLimits.setStorePath(undefined)
})

beforeEach(() => {
  store = join(tmpdir(), `banyancode-claude-rate-limits-${randomUUID()}.json`)
  ClaudeRateLimits.setStorePath(store)
  ClaudeRateLimits.reset()
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

const oauth = (token: string, metadata?: Record<string, unknown>) =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("fixture"),
    access: token,
    refresh: `refresh-${token}`,
    expires: Date.now() + 60_000,
    ...(metadata === undefined ? {} : { metadata }),
  })

const key = (secret: string) => Credential.Key.make({ type: "key", key: secret })

const external = () =>
  Credential.External.make({ type: "external", methodID: Integration.MethodID.make("claude-login") })

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

const claudeTarget = () =>
  target({
    providerID: "claude-agent",
    displayName: "Claude Agent",
    authType: "external",
    credential: external(),
  })

const recordRateLimits = (rateLimitInfo: Record<string, unknown>) => {
  const convert = ConvertClaudeStream.make([])
  convert({
    type: "rate_limit_event",
    rate_limit_info: rateLimitInfo,
    uuid: "rate-limit",
    session_id: "session",
  } as unknown as SDKMessage)
}

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

  test("OpenCode Go OAuth credentials fetch real usage with the workspace id", async () => {
    const requests: Array<{ authorization: string | null; org: string | null }> = []
    const base = serve((request) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        org: request.headers.get("x-opencode-org-id"),
      })
      return Response.json({
        usage: {
          rolling: { percent: 25, resetsAt: "2026-11-02T12:00:00Z" },
          weekly: { percent: 40, resetsAt: "2026-11-08T12:00:00Z" },
          monthly: { percent: 10, resetsAt: "2026-12-01T12:00:00Z" },
        },
      })
    })
    const token = "oauth-access-TOPSECRET"
    const result = await snapshots(
      [
        target({
          providerID: "opencode-go",
          displayName: "OpenCode",
          authType: "oauth",
          credential: oauth(token, { orgID: "org_fixture" }),
        }),
      ],
      { endpoints: endpointsFor(base) },
    )
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("available")
    expect(snapshot.windows.map((window) => window.label)).toEqual(["5h", "1w", "1mo"])
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([25, 40, 10])
    expect(requests).toEqual([{ authorization: `Bearer ${token}`, org: "org_fixture" }])
    expect(JSON.stringify(result)).not.toContain(token)
  })

  test("an OpenCode OAuth quota refusal is not reported as Not connected", async () => {
    const base = serve(() => new Response("forbidden", { status: 403 }))
    const result = await snapshots(
      [
        target({
          providerID: "opencode-go",
          displayName: "OpenCode",
          authType: "oauth",
          credential: oauth("oauth-access-TOPSECRET"),
        }),
      ],
      { endpoints: endpointsFor(base) },
    )
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("unsupported")
    expect(snapshot.message).toBe("OpenCode Go usage is unavailable for this account")
    expect(snapshot.windows).toEqual([])
  })

  test("Claude Agent rate-limit events become reported quota windows", async () => {
    const convert = ConvertClaudeStream.make([])
    convert({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        resetsAt: Math.floor(Date.now() / 1000) + 3_600,
        unifiedWindows: {
          five_hour: { utilization: 0.62, resetsAt: Math.floor(Date.now() / 1000) + 3_600 },
          seven_day: { utilization: 31, resetsAt: Math.floor(Date.now() / 1000) + 86_400 },
        },
      },
      uuid: "rate-limit",
      session_id: "session",
    } as unknown as SDKMessage)
    const result = await snapshots(
      [
        target({
          providerID: "claude-agent",
          displayName: "Claude Agent",
          authType: "external",
          credential: external(),
        }),
      ],
      { fetchImpl: () => Promise.reject(new Error("must not be called")) },
    )
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("available")
    expect(snapshot.confidence).toBe("reported")
    expect(snapshot.windows.map((window) => window.label)).toEqual(["5h", "1w"])
    expect(snapshot.windows[0]!.usedPercent).toBe(62)
    expect(snapshot.windows[0]!.remainingPercent).toBe(38)
    expect(snapshot.windows[0]!.resetsAt).toBeGreaterThan(Date.now())
    expect(snapshot.windows[1]!.usedPercent).toBe(31)
  })

  test("a connected Claude Agent without an observed response says limits are pending", async () => {
    const result = await snapshots(
      [
        target({
          providerID: "claude-agent",
          displayName: "Claude Agent",
          authType: "external",
          credential: external(),
        }),
      ],
      { fetchImpl: () => Promise.reject(new Error("must not be called")) },
    )
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("unsupported")
    expect(snapshot.message).toBe("Limits appear after the first response")
    expect(snapshot.windows).toEqual([])
  })

  test("a plain read returns Claude Agent bars right after an event is recorded", async () => {
    let requests = 0
    const base = serve(() => {
      requests++
      return Response.json({ data: { limit: 10, usage: 2 } })
    })
    const usage = await Effect.runPromise(
      ProviderUsage.make({
        targets: () =>
          Effect.succeed([
            claudeTarget(),
            target({ providerID: "openrouter", displayName: "OpenRouter", credential: key("sk-openrouter-secret") }),
          ]),
        endpoints: endpointsFor(base),
      }),
    )

    const waiting = await Effect.runPromise(usage.snapshots())
    const pending = waiting.snapshots.find((snapshot) => snapshot.providerID === "claude-agent")!
    expect(pending.status).toBe("unsupported")
    expect(pending.message).toBe("Limits appear after the first response")
    expect(requests).toBe(1)

    recordRateLimits({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.51, resetsAt: Math.floor(Date.now() / 1000) + 3_600 },
        seven_day: { utilization: 91, resetsAt: Math.floor(Date.now() / 1000) + 86_400 },
      },
    })

    const after = await Effect.runPromise(usage.snapshots())
    const claude = after.snapshots.find((snapshot) => snapshot.providerID === "claude-agent")!
    expect(claude.status).toBe("available")
    expect(claude.windows.map((window) => window.label)).toEqual(["5h", "1w"])
    expect(claude.windows.map((window) => window.usedPercent)).toEqual([51, 91])
    // Only the changed provider is re-read; the cached OpenCode-style row is untouched.
    expect(requests).toBe(1)
  })

  test("the last Claude Agent observation survives a restart", async () => {
    recordRateLimits({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.51, resetsAt: Math.floor(Date.now() / 1000) + 3_600 },
        seven_day: { utilization: 91, resetsAt: Math.floor(Date.now() / 1000) + 86_400 },
      },
    })
    ClaudeRateLimits.restart()

    const result = await snapshots([claudeTarget()], {
      fetchImpl: () => Promise.reject(new Error("must not be called")),
    })
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("available")
    expect(snapshot.windows.map((window) => window.usedPercent)).toEqual([51, 91])
    expect(snapshot.windows[0]!.resetsAt).toBeGreaterThan(Date.now())
  })

  test("a corrupt Claude Agent state file is ignored", async () => {
    recordRateLimits({
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: Math.floor(Date.now() / 1000) + 60 } },
    })
    ClaudeRateLimits.restart()
    const restored = await snapshots([claudeTarget()], {
      fetchImpl: () => Promise.reject(new Error("must not be called")),
    })
    expect(restored.snapshots[0]!.status).toBe("available")
    expect(restored.snapshots[0]!.windows[0]!.usedPercent).toBe(20)

    writeFileSync(store, "{not json", "utf8")
    ClaudeRateLimits.restart()
    const result = await snapshots([claudeTarget()], {
      fetchImpl: () => Promise.reject(new Error("must not be called")),
    })
    expect(result.snapshots[0]!.status).toBe("unsupported")
    expect(result.snapshots[0]!.message).toBe("Limits appear after the first response")
  })

  test("a persisted window past its reset shows the update message after a restart", async () => {
    recordRateLimits({
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: Math.floor(Date.now() / 1000) - 60 } },
    })
    ClaudeRateLimits.restart()

    const result = await snapshots([claudeTarget()], {
      fetchImpl: () => Promise.reject(new Error("must not be called")),
    })
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("unsupported")
    expect(snapshot.message).toBe("Limits update after the next response")
    expect(snapshot.windows).toEqual([])
  })

  test("an expired Claude Agent window is not shown as current usage", async () => {
    const convert = ConvertClaudeStream.make([])
    convert({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.9, resetsAt: Math.floor(Date.now() / 1000) - 60 },
        },
      },
      uuid: "rate-limit",
      session_id: "session",
    } as unknown as SDKMessage)
    const result = await snapshots(
      [
        target({
          providerID: "claude-agent",
          displayName: "Claude Agent",
          authType: "external",
          credential: external(),
        }),
      ],
      { fetchImpl: () => Promise.reject(new Error("must not be called")) },
    )
    const snapshot = result.snapshots[0]!
    expect(snapshot.status).toBe("unsupported")
    expect(snapshot.message).toBe("Limits update after the next response")
    expect(snapshot.windows).toEqual([])
  })

  test("a disconnected Claude Agent stays unauthenticated", async () => {
    const result = await snapshots(
      [
        target({
          providerID: "claude-agent",
          displayName: "Claude Agent",
          hasAuth: false,
          credential: undefined,
        }),
      ],
      { fetchImpl: () => Promise.reject(new Error("must not be called")) },
    )
    expect(result.snapshots[0]).toMatchObject({
      status: "unauthenticated",
      message: "Not connected",
      windows: [],
    })
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

  test("an OpenCode Go alias reuses the Console OAuth connection", async () => {
    const token = "oauth-console-TOPSECRET"
    const requests: Array<{ authorization: string | null; org: string | null }> = []
    const base = serve((request) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        org: request.headers.get("x-opencode-org-id"),
      })
      return Response.json({
        usage: {
          rolling: { percent: 12, resetsAt: "2027-01-01T00:00:00Z" },
          weekly: { percent: 34, resetsAt: "2027-01-08T00:00:00Z" },
        },
      })
    })
    const provider = { id: "opencode-go", name: "OpenCode Go", activation: "auto", package: "" } as const
    const connection: IntegrationConnection.Info = {
      type: "credential",
      id: Credential.ID.make("cred_console"),
      label: "OpenCode Console",
      method: "oauth",
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
        active: (integrationID: Integration.ID) =>
          Effect.succeed(String(integrationID) === "opencode" ? connection : undefined),
        resolve: () => Effect.succeed(oauth(token, { orgID: "org_fixture" })),
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
    const snapshot = result.snapshots[0]!
    expect(snapshot.providerID).toBe("opencode-go")
    expect(snapshot.status).toBe("available")
    expect(snapshot.windows.map((window) => window.label)).toEqual(["5h", "1w"])
    expect(requests).toEqual([{ authorization: `Bearer ${token}`, org: "org_fixture" }])
    expect(JSON.stringify(result)).not.toContain(token)
  })
})
