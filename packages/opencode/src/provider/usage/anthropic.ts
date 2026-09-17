/**
 * Anthropic OAuth usage adapter (provider-usage sidebar).
 *
 * Calls `GET https://api.anthropic.com/api/oauth/usage` with the Claude
 * subscription OAuth bearer token and the `anthropic-beta: oauth-2025-04-20`
 * header. Normalizes the session (`five_hour`) and weekly windows, preserving
 * any additional provider-supplied windows (Sonnet/Opus/OAuth-apps/Cowork)
 * instead of dropping them.
 *
 * Contract follows the MIT-licensed `xihuai18/opencode-quota-sidebar`
 * anthropic adapter: each window is `{ utilization, resets_at }` where
 * `utilization` is either a 0-1 fraction or a 0-100 percent. Ordinary
 * Anthropic API keys expose no account quota endpoint, so non-OAuth callers
 * resolve to `unsupported`, never to fabricated limits.
 *
 * The endpoint is aggressively rate-limited upstream; the refresh interval is
 * 5 minutes to stay clear of it.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"
export const ANTHROPIC_PROVIDER_IDS = ["anthropic"] as const

const WINDOW_DEFS = [
  { field: "five_hour", label: "5h", durationSeconds: 18_000 },
  { field: "seven_day", label: "Weekly", durationSeconds: 604_800 },
  { field: "seven_day_sonnet", label: "Sonnet 7d", durationSeconds: 604_800 },
  { field: "seven_day_opus", label: "Opus 7d", durationSeconds: 604_800 },
  { field: "seven_day_oauth_apps", label: "OAuth Apps 7d", durationSeconds: 604_800 },
  { field: "seven_day_cowork", label: "Cowork 7d", durationSeconds: 604_800 },
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Upstream sends either a 0-1 fraction or a 0-100 percent. */
const toUsedPercent = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric === undefined) return undefined
  return numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric
}

const toResetsAt = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric !== undefined) return numeric
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeAnthropicUsage = (
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
  if (!isRecord(payload)) fail("Anthropic returned an unrecognized usage payload")
  const usage: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  const windows: Banyan.ProviderUsageWindow[] = []
  for (const def of WINDOW_DEFS) {
    const entry = usage[def.field]
    if (!isRecord(entry)) continue
    const usedPercent = toUsedPercent(entry["utilization"])
    if (usedPercent === undefined) continue
    windows.push(
      Banyan.normalizeWindow({
        id: def.field,
        label: def.label,
        kind: "quota",
        usedPercent,
        resetsAt: toResetsAt(entry["resets_at"]),
        durationSeconds: def.durationSeconds,
      }),
    )
  }
  if (windows.length === 0) fail("Anthropic returned no usage windows")
  return new Banyan.ProviderUsageSnapshot({
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows,
    fetchedAt: input.fetchedAt ?? Date.now(),
  })
}

export const AnthropicAdapter: Adapter = {
  id: "banyan-usage-anthropic",
  providerID: "anthropic",
  refreshIntervalSeconds: 300,
  supports: (input) =>
    (ANTHROPIC_PROVIDER_IDS as readonly string[]).includes(input.providerID) &&
    (input.authType === "oauth" || !input.hasAuth),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const auth = ctx.auth
      if (!auth) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Anthropic is not connected",
        })
      }
      if (auth.type !== "oauth") {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unsupported",
          message: "Anthropic API keys expose no account quota endpoint",
        })
      }
      if (auth.expires < Date.now()) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Anthropic session expired — re-authenticate to refresh usage",
        })
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          ctx.fetch(ANTHROPIC_USAGE_URL, {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${auth.access}`,
              "content-type": "application/json",
              "anthropic-beta": ANTHROPIC_OAUTH_BETA,
            },
          }),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "network",
            message: "Anthropic usage request failed",
          }),
      })
      if (response.status === 401 || response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Anthropic rejected the session — re-authenticate to refresh usage",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "Anthropic usage rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `Anthropic usage returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "Anthropic returned an unreadable usage payload",
          }),
      })
      return normalizeAnthropicUsage(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
