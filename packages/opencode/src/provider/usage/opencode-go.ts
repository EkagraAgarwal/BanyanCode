/**
 * OpenCode Go usage adapter (provider-usage sidebar, Phase 1).
 *
 * Calls `GET https://opencode.ai/zen/go/v1/usage` with the workspace API
 * key. Credential precedence: `OPENCODE_API_KEY` env, then
 * `provider.opencode-go` / `provider.opencode` config options, then the
 * active `opencode-go` auth entry, then the legacy `opencode` auth entry.
 *
 * Live contract (verified against the endpoint): `{ usage: { rolling,
 * weekly, monthly } }` where each window carries `percent` (used percent,
 * 0-100) and an ISO-string `resetsAt`. Durations are implied by the window
 * key (rolling = 5h, weekly = 1w, monthly = 1mo). The endpoint does not
 * return a credit balance, so none is inferred.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
export const OPENCODE_GO_PROVIDER_IDS = ["opencode", "opencode-go"] as const

const WINDOW_DEFS = [
  { field: "rolling", durationSeconds: 18_000 },
  { field: "weekly", durationSeconds: 604_800 },
  { field: "monthly", durationSeconds: 2_592_000 },
] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const pickNumber = (entry: Record<string, unknown>, names: ReadonlyArray<string>): number | undefined => {
  for (const name of names) {
    const value = toFiniteNumber(entry[name])
    if (value !== undefined) return value
  }
  return undefined
}

const pickString = (entry: Record<string, unknown>, names: ReadonlyArray<string>): string | undefined => {
  for (const name of names) {
    const value = entry[name]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** Reset timestamps arrive as epoch seconds/millis or ISO strings. Strings
 * are parsed to epoch millis here; numerics pass through untouched so the
 * shared normalizer applies its seconds-vs-millis rule. */
const toResetsAt = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric !== undefined) return numeric
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const RESET_NAMES = ["resetsAt", "resets_at", "reset_at", "resetAt", "resets", "reset"] as const

/** Window entries accept the live `percent` field plus the legacy
 * snake_case/camelCase percent names. Explicit durations win; envelope
 * windows fall back to the key-implied duration. */
const toWindowInput = (
  key: string,
  entry: Record<string, unknown>,
  durationSeconds?: number,
): Banyan.NormalizeWindowInput => ({
  id: pickString(entry, ["id"]) ?? key,
  label: pickString(entry, ["label", "name", "title"]),
  kind: "quota",
  usedPercent: pickNumber(entry, ["percent", "used_percent", "usedPercent", "used"]),
  remainingPercent: pickNumber(entry, ["remaining_percent", "remainingPercent"]),
  resetsAt: (() => {
    for (const name of RESET_NAMES) {
      const parsed = toResetsAt(entry[name])
      if (parsed !== undefined) return parsed
    }
    return undefined
  })(),
  durationSeconds:
    pickNumber(entry, ["duration_seconds", "durationSeconds", "duration", "window_seconds"]) ?? durationSeconds,
  limit: pickNumber(entry, ["limit", "total"]),
  remaining: pickNumber(entry, ["remaining", "left"]),
})

/** Live shape first: `{ usage: { rolling, weekly, monthly } }`. Falls back
 * to the legacy `windows` array, then to a top-level rolling/weekly/monthly
 * map. Anything else yields no entries and the caller fails upstream. */
const collectEntries = (
  payload: unknown,
): Array<{ key: string; entry: Record<string, unknown>; durationSeconds?: number }> => {
  if (!isRecord(payload)) return []
  const usage = payload["usage"]
  if (isRecord(usage)) {
    const entries: Array<{ key: string; entry: Record<string, unknown>; durationSeconds?: number }> = []
    for (const def of WINDOW_DEFS) {
      const entry = usage[def.field]
      if (isRecord(entry)) entries.push({ key: def.field, entry, durationSeconds: def.durationSeconds })
    }
    for (const [key, value] of Object.entries(usage)) {
      if (isRecord(value) && !WINDOW_DEFS.some((def) => def.field === key)) entries.push({ key, entry: value })
    }
    return entries
  }
  const windows = payload["windows"]
  if (Array.isArray(windows)) {
    return windows
      .filter((item) => isRecord(item))
      .map((entry, index) => ({
        key: pickString(entry, ["id", "label", "name"]) ?? `windows-${index}`,
        entry,
      }))
  }
  // Legacy object-map shape: { rolling: {...}, weekly: {...}, monthly: {...} }.
  const entries: Array<{ key: string; entry: Record<string, unknown>; durationSeconds?: number }> = []
  for (const [key, value] of Object.entries(payload)) {
    if (!isRecord(value)) continue
    const def = WINDOW_DEFS.find((item) => item.field === key)
    entries.push(def ? { key, entry: value, durationSeconds: def.durationSeconds } : { key, entry: value })
  }
  return entries
}

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeOpenCodeGoUsage = (
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
  if (!isRecord(payload)) fail("OpenCode Go returned an unrecognized usage payload")
  const entries = collectEntries(payload)
  if (entries.length === 0) fail("OpenCode Go returned no usage windows")
  return new Banyan.ProviderUsageSnapshot({
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: entries.map(({ key, entry, durationSeconds }) =>
      Banyan.normalizeWindow(toWindowInput(key, entry, durationSeconds)),
    ),
    fetchedAt: input.fetchedAt ?? Date.now(),
  })
}

/** Resolve the workspace API key by documented precedence. Returns undefined when absent. */
export const resolveOpenCodeGoApiKey = (ctx: AdapterContext): string | undefined => {
  const fromEnv = process.env.OPENCODE_API_KEY
  if (fromEnv && fromEnv.length > 0) return fromEnv
  const fromOptions = ctx.options["apiKey"]
  if (typeof fromOptions === "string" && fromOptions.length > 0) return fromOptions
  if (ctx.auth?.type === "api" && ctx.auth.key.length > 0) return ctx.auth.key
  return undefined
}

const fetchUsage = (ctx: AdapterContext, apiKey: string) =>
  Effect.tryPromise({
    try: () =>
      ctx.fetch(OPENCODE_GO_USAGE_URL, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
      }),
    catch: () =>
      new Banyan.ProviderUsageError({
        providerID: ctx.providerID,
        reason: "network",
        message: "OpenCode Go usage request failed",
      }),
  })

export const OpenCodeGoAdapter: Adapter = {
  id: "banyan-usage-opencode-go",
  providerID: "opencode",
  refreshIntervalSeconds: 60,
  supports: (input) => (OPENCODE_GO_PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx) =>
    Effect.gen(function* () {
      const apiKey = resolveOpenCodeGoApiKey(ctx)
      if (!apiKey) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "OpenCode Go is not connected",
        })
      }
      const response = yield* fetchUsage(ctx, apiKey)
      if (response.status === 401 || response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "OpenCode Go rejected the API key",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "OpenCode Go usage rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `OpenCode Go usage returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "OpenCode Go returned an unreadable usage payload",
          }),
      })
      return normalizeOpenCodeGoUsage(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
