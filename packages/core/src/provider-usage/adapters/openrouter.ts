export * as OpenRouterUsage from "./openrouter.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import { clampPercent, normalizeWindow, type Snapshot } from "../schema.js"
import { fromThrow, isRecord, requestJson, toFiniteNumber } from "./http.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * OpenRouter usage adapter (provider-usage sidebar parity).
 *
 * Calls the fixed `GET https://openrouter.ai/api/v1/key` endpoint and
 * normalizes `{ data: { limit, usage } }` into remaining credits plus a quota
 * window.
 */

export const PROVIDER_IDS = ["openrouter"] as const

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeOpenRouterKey = (
  payload: unknown,
  input: { providerID: string; displayName: string; fetchedAt?: number },
): Snapshot => {
  const data = isRecord(payload) && isRecord(payload["data"]) ? payload["data"] : undefined
  if (!data) {
    throw new ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message: "OpenRouter returned an unrecognized key payload",
    })
  }
  const limit = toFiniteNumber(data.limit)
  const usage = toFiniteNumber(data.usage)
  if (limit === undefined || usage === undefined) {
    throw new ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message: "OpenRouter returned no limit or usage",
    })
  }
  const remaining = Math.max(0, limit - usage)
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: [
      normalizeWindow({
        id: "credits",
        label: "Credits",
        kind: "quota",
        usedPercent: limit > 0 ? clampPercent((usage / limit) * 100) : 0,
        limit,
        remaining,
      }),
    ],
    balance: { remaining },
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

export const OpenRouterAdapter: Adapter = {
  id: "banyan-usage-openrouter",
  providerID: "openrouter",
  refreshIntervalSeconds: 60,
  supports: (input) => (PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      const apiKey = credential?.type === "key" && credential.key.length > 0 ? credential.key : undefined
      if (!apiKey)
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "OpenRouter is not connected",
        })
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: ctx.endpoints.openrouter,
        headers: { authorization: `Bearer ${apiKey}` },
        label: "OpenRouter key",
        unauthorized: "OpenRouter rejected the API key",
        rateLimited: "OpenRouter key rate limited",
        unreadable: "OpenRouter returned an unreadable key payload",
      })
      return yield* fromThrow(ctx.providerID, () =>
        normalizeOpenRouterKey(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
