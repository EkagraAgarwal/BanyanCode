export * as AnthropicUsage from "./anthropic.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import {
  normalizeWindow,
  type Snapshot,
  type Window,
} from "../schema.js"
import { fromThrow, isRecord, requestJson, toFiniteNumber, toResetsAt } from "./http.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * Anthropic OAuth usage adapter (provider-usage sidebar parity).
 *
 * Calls the fixed `GET https://api.anthropic.com/api/oauth/usage` endpoint
 * with the Claude subscription OAuth bearer token. Ordinary Anthropic API
 * keys expose no account quota endpoint, so non-OAuth callers resolve to
 * `unsupported`, never to fabricated limits. The endpoint is aggressively
 * rate-limited upstream, so the refresh interval is 5 minutes.
 */

export const BETA = "oauth-2025-04-20"
export const PROVIDER_IDS = ["anthropic"] as const

const WINDOW_DEFS = [
  { field: "five_hour", label: "5h", durationSeconds: 18_000 },
  { field: "seven_day", label: "Weekly", durationSeconds: 604_800 },
  { field: "seven_day_sonnet", label: "Sonnet 7d", durationSeconds: 604_800 },
  { field: "seven_day_opus", label: "Opus 7d", durationSeconds: 604_800 },
  { field: "seven_day_oauth_apps", label: "OAuth Apps 7d", durationSeconds: 604_800 },
  { field: "seven_day_cowork", label: "Cowork 7d", durationSeconds: 604_800 },
] as const

/** Upstream sends either a 0-1 fraction or a 0-100 percent. */
const toUsedPercent = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric === undefined) return undefined
  return numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric
}

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeAnthropicUsage = (
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
  if (!isRecord(payload)) fail("Anthropic returned an unrecognized usage payload")
  const usage: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  const windows: Window[] = []
  for (const def of WINDOW_DEFS) {
    const entry = usage[def.field]
    if (!isRecord(entry)) continue
    const usedPercent = toUsedPercent(entry["utilization"])
    if (usedPercent === undefined) continue
    windows.push(
      normalizeWindow({
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
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows,
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

export const AnthropicAdapter: Adapter = {
  id: "banyan-usage-anthropic",
  providerID: "anthropic",
  refreshIntervalSeconds: 300,
  supports: (input) =>
    (PROVIDER_IDS as readonly string[]).includes(input.providerID) &&
    (input.authType === "oauth" || !input.hasAuth),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      if (!credential)
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Anthropic is not connected",
        })
      if (credential.type !== "oauth")
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unsupported",
          message: "Anthropic API keys expose no account quota endpoint",
        })
      if (credential.expires < Date.now())
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Anthropic session expired — re-authenticate to refresh usage",
        })
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: ctx.endpoints.anthropic,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.access}`,
          "content-type": "application/json",
          "anthropic-beta": BETA,
        },
        label: "Anthropic usage",
        unauthorized: "Anthropic rejected the session — re-authenticate to refresh usage",
        rateLimited: "Anthropic usage rate limited",
        unreadable: "Anthropic returned an unreadable usage payload",
      })
      return yield* fromThrow(ctx.providerID, () =>
        normalizeAnthropicUsage(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
