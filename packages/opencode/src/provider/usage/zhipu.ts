/**
 * Zhipu coding-plan quota adapter (provider-usage sidebar).
 *
 * Calls `GET https://bigmodel.cn/api/monitor/usage/quota/limit` with the raw
 * API key as the `Authorization` header value (no `Bearer` scheme) and
 * normalizes the `TOKENS_LIMIT` window into a used/remaining quota window.
 * International accounts served from `api.z.ai` use the matching regional
 * quota host; the selection is derived from the provider `baseURL` option.
 *
 * Contract follows the MIT-licensed `xihuai18/opencode-quota-sidebar`
 * zhipu-coding-plan adapter: `{ success, code, msg, data: { level, limits:
 * [{ type, percentage, unit, number, nextResetTime }] } }`.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const ZHIPU_QUOTA_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit"
export const ZHIPU_INTL_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit"
export const ZHIPU_PROVIDER_IDS = ["zhipuai-coding-plan", "zhipu", "zhipuai", "zai"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const toResetsAt = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric !== undefined) return numeric
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const quotaUrl = (baseURL: unknown): string => {
  if (typeof baseURL === "string") {
    try {
      if (new URL(baseURL).host === "api.z.ai") return ZHIPU_INTL_QUOTA_URL
    } catch {
      // Ignore malformed base URLs; fall through to the default host.
    }
  }
  return ZHIPU_QUOTA_URL
}

const tokenWindowLabel = (unit: unknown, count: unknown): string => {
  const unitValue = toFiniteNumber(unit)
  const countValue = toFiniteNumber(count)
  if (unitValue === 3 && countValue !== undefined && countValue > 0) return `${Math.round(countValue)}h`
  if (unitValue === 1 && countValue === 7) return "Weekly"
  if (unitValue === 1 && countValue !== undefined && countValue > 0) return `${Math.round(countValue)}d`
  if (unitValue === 5 && countValue !== undefined && countValue > 0) return `${Math.round(countValue)}m`
  return "Tokens"
}

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeZhipuQuota = (
  payload: unknown,
  input: { providerID: string; displayName: string; fetchedAt?: number },
): Banyan.ProviderUsageSnapshot => {
  const fail = (message: string): never => {
    throw new Banyan.ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message,
    })
  }
  if (!isRecord(payload)) fail("Zhipu returned an unrecognized quota payload")
  const root: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  if (root["success"] !== true || toFiniteNumber(root["code"]) !== 200) {
    const detail = typeof root["msg"] === "string" && root["msg"].length > 0 ? root["msg"] : "quota request failed"
    fail(`Zhipu ${detail}`)
  }
  const data = isRecord(root["data"]) ? root["data"] : undefined
  const limits = data !== undefined && Array.isArray(data["limits"]) ? data["limits"] : []
  const token = limits
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .find((item) => item["type"] === "TOKENS_LIMIT")
  if (!token) fail("Zhipu returned no quota window")
  const entry: Record<string, unknown> = isRecord(token) ? token : fail("unreachable")
  const usedPercent = toFiniteNumber(entry["percentage"])
  if (usedPercent === undefined) fail("Zhipu returned no quota window")
  return new Banyan.ProviderUsageSnapshot({
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: [
      Banyan.normalizeWindow({
        id: "tokens",
        label: tokenWindowLabel(entry["unit"], entry["number"]),
        kind: "quota",
        usedPercent,
        resetsAt: toResetsAt(entry["nextResetTime"]),
      }),
    ],
    fetchedAt: input.fetchedAt ?? Date.now(),
  })
}

const resolveApiKey = (ctx: AdapterContext): string | undefined => {
  const fromOptions = ctx.options["apiKey"]
  if (typeof fromOptions === "string" && fromOptions.length > 0) return fromOptions
  const auth = ctx.auth
  if (!auth) return undefined
  if (auth.type === "api" && auth.key.length > 0) return auth.key
  if (auth.type === "wellknown") {
    if (auth.key.length > 0) return auth.key
    if (auth.token.length > 0) return auth.token
  }
  if (auth.type === "oauth" && auth.access.length > 0) return auth.access
  return undefined
}

export const ZhipuAdapter: Adapter = {
  id: "banyan-usage-zhipu",
  providerID: "zhipuai-coding-plan",
  refreshIntervalSeconds: 60,
  supports: (input) => (ZHIPU_PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const apiKey = resolveApiKey(ctx)
      if (!apiKey) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Zhipu is not connected",
        })
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          ctx.fetch(quotaUrl(ctx.options["baseURL"]), {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: apiKey,
              "content-type": "application/json",
            },
          }),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "network",
            message: "Zhipu quota request failed",
          }),
      })
      if (response.status === 401 || response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Zhipu rejected the API key",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "Zhipu quota rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `Zhipu quota returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "Zhipu returned an unreadable quota payload",
          }),
      })
      return normalizeZhipuQuota(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
