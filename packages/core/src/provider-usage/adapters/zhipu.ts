export * as ZhipuUsage from "./zhipu.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import { normalizeWindow, type Snapshot } from "../schema.js"
import { fromThrow, isRecord, requestJson, toFiniteNumber, toResetsAt } from "./http.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * Zhipu coding-plan quota adapter (provider-usage sidebar parity).
 *
 * Calls the fixed `GET https://bigmodel.cn/api/monitor/usage/quota/limit`
 * endpoint with the raw API key as the `Authorization` header value (no
 * `Bearer` scheme). International accounts served from `api.z.ai` use the
 * matching regional quota host, selected from the provider `settings.baseURL`
 * host — never from caller input.
 */

export const PROVIDER_IDS = ["zhipuai-coding-plan", "zhipu", "zhipuai", "zai"] as const

const quotaUrl = (ctx: AdapterContext): string => {
  const baseURL = ctx.settings?.baseURL
  if (typeof baseURL === "string") {
    try {
      if (new URL(baseURL).host === "api.z.ai") return ctx.endpoints.zhipuIntl
    } catch {
      // Ignore malformed base URLs; fall through to the default host.
    }
  }
  return ctx.endpoints.zhipu
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

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeZhipuQuota = (
  payload: unknown,
  input: { providerID: string; displayName: string; fetchedAt?: number },
): Snapshot => {
  const fail = (message: string): never => {
    throw new ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message,
    })
  }
  if (!isRecord(payload)) fail("Zhipu returned an unrecognized quota payload")
  const root: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  if (root["success"] !== true || toFiniteNumber(root["code"]) !== 200) {
    // The upstream `msg` is attacker-influenced; the service redacts the
    // resulting snapshot message before it leaves core.
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
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: [
      normalizeWindow({
        id: "tokens",
        label: tokenWindowLabel(entry["unit"], entry["number"]),
        kind: "quota",
        usedPercent,
        resetsAt: toResetsAt(entry["nextResetTime"]),
      }),
    ],
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

export const ZhipuAdapter: Adapter = {
  id: "banyan-usage-zhipu",
  providerID: "zhipuai-coding-plan",
  refreshIntervalSeconds: 60,
  supports: (input) => (PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      const apiKey =
        credential?.type === "key" && credential.key.length > 0
          ? credential.key
          : credential?.type === "oauth" && credential.access.length > 0
            ? credential.access
            : undefined
      if (!apiKey)
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Zhipu is not connected",
        })
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: quotaUrl(ctx),
        headers: { accept: "application/json", authorization: apiKey, "content-type": "application/json" },
        label: "Zhipu quota",
        unauthorized: "Zhipu rejected the API key",
        rateLimited: "Zhipu quota rate limited",
        unreadable: "Zhipu returned an unreadable quota payload",
      })
      return yield* fromThrow(ctx.providerID, () =>
        normalizeZhipuQuota(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
