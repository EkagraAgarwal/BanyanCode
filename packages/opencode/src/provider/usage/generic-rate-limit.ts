/**
 * Generic rate-limit header adapter (provider-usage sidebar, Phase 3).
 *
 * Fallback for configured providers with no exact adapter. Serves the last
 * observed normalized rate-limit headers as `reported` windows. Providers
 * with no fresh observation stay `unsupported`; providers without
 * credentials stay `unauthenticated`.
 *
 * This adapter must remain last in `BUILT_IN_ADAPTERS` so exact adapters win.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter } from "../usage"
import {
  OBSERVER_DEFAULT_TTL_MS,
  pruneObservationsForAccount,
  readObservedRateLimit,
} from "./observer"

export const GENERIC_RATE_LIMIT_ADAPTER_ID = "banyan-usage-generic-rate-limit"
export const GENERIC_RATE_LIMIT_TTL_MS = OBSERVER_DEFAULT_TTL_MS

export const GenericRateLimitAdapter: Adapter = {
  id: GENERIC_RATE_LIMIT_ADAPTER_ID,
  providerID: "generic-rate-limit",
  refreshIntervalSeconds: 60,
  // Gate on credentials so providers with no auth keep the historical
  // `unsupported` outcome (no adapter matched) instead of flipping to
  // `unauthenticated`. Authenticated providers with no fresh observation
  // still resolve to `unsupported` via the fetch below.
  supports: (input) => input.hasAuth,
  fetch: (ctx) =>
    Effect.gen(function* () {
      if (!ctx.auth) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: `${ctx.displayName} is not connected`,
        })
      }
      // Partition: a switched account must never read the previous
      // account's observation. Keep only the current account's entry.
      pruneObservationsForAccount(ctx.providerID, ctx.accountKey)
      const observed = readObservedRateLimit(ctx.providerID, ctx.accountKey, {
        ttlMs: GENERIC_RATE_LIMIT_TTL_MS,
      })
      if (!observed || observed.windows.length === 0) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unsupported",
          message: `${ctx.displayName} exposes no observable rate limits`,
        })
      }
      return new Banyan.ProviderUsageSnapshot({
        providerID: ctx.providerID,
        displayName: ctx.displayName,
        status: "available",
        confidence: "reported",
        windows: observed.windows.map((window) =>
          Banyan.normalizeWindow({
            id: window.id,
            label: window.label,
            kind: "rate_limit",
            ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
            ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
            ...(window.limit !== undefined ? { limit: window.limit } : {}),
            ...(window.remaining !== undefined ? { remaining: window.remaining } : {}),
          }),
        ),
        fetchedAt: Date.now(),
      })
    }),
}
