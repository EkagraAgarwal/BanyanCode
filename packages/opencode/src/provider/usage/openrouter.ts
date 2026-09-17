/**
 * OpenRouter usage adapter (provider-usage sidebar, Phase 1).
 *
 * Calls `GET https://openrouter.ai/api/v1/key` with the API key and
 * normalizes `{ data: { limit, usage } }` into remaining credits plus a
 * quota window. Documented at
 * https://openrouter.ai/docs/api_reference/limits.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"
export const OPENROUTER_PROVIDER_IDS = ["openrouter"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeOpenRouterKey = (
  payload: unknown,
  input: { providerID: string; displayName: string; fetchedAt?: number },
): Banyan.ProviderUsageSnapshot => {
  const data = isRecord(payload) && isRecord(payload["data"]) ? payload["data"] : undefined
  if (!data) {
    throw new Banyan.ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message: "OpenRouter returned an unrecognized key payload",
    })
  }
  const limit = toFiniteNumber(data.limit)
  const usage = toFiniteNumber(data.usage)
  if (limit === undefined || usage === undefined) {
    throw new Banyan.ProviderUsageError({
      providerID: input.providerID,
      reason: "upstream",
      message: "OpenRouter returned no limit or usage",
    })
  }
  const remaining = Math.max(0, limit - usage)
  return new Banyan.ProviderUsageSnapshot({
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: [
      Banyan.normalizeWindow({
        id: "credits",
        label: "Credits",
        kind: "quota",
        usedPercent: limit > 0 ? Banyan.clampPercent((usage / limit) * 100) : 0,
        limit,
        remaining,
      }),
    ],
    balance: new Banyan.ProviderUsageBalance({ remaining }),
    fetchedAt: input.fetchedAt ?? Date.now(),
  })
}

export const OpenRouterAdapter: Adapter = {
  id: "banyan-usage-openrouter",
  providerID: "openrouter",
  refreshIntervalSeconds: 60,
  supports: (input) => (OPENROUTER_PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx) =>
    Effect.gen(function* () {
      const apiKey =
        ctx.auth?.type === "api" && ctx.auth.key.length > 0
          ? ctx.auth.key
          : typeof ctx.options["apiKey"] === "string"
            ? (ctx.options["apiKey"] as string)
            : undefined
      if (!apiKey) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "OpenRouter is not connected",
        })
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          ctx.fetch(OPENROUTER_KEY_URL, {
            method: "GET",
            headers: { authorization: `Bearer ${apiKey}` },
          }),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "network",
            message: "OpenRouter key request failed",
          }),
      })
      if (response.status === 401 || response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "OpenRouter rejected the API key",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "OpenRouter key rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `OpenRouter key returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "OpenRouter returned an unreadable key payload",
          }),
      })
      return normalizeOpenRouterKey(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
