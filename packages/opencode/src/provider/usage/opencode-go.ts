/**
 * OpenCode Go usage adapter (provider-usage sidebar, Phase 1).
 *
 * Calls `GET https://opencode.ai/zen/go/v1/usage` with the workspace API
 * key. Credential precedence: `OPENCODE_API_KEY` env, then
 * `provider.opencode-go` / `provider.opencode` config options, then the
 * active `opencode-go` auth entry, then the legacy `opencode` auth entry.
 * Normalizes rolling, weekly, and monthly windows. The endpoint does not
 * return a credit balance, so none is inferred.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
export const OPENCODE_GO_PROVIDER_IDS = ["opencode", "opencode-go"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

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

/** Upstream window entries accept snake_case and camelCase field names. */
const toWindowInput = (key: string, entry: Record<string, unknown>): Banyan.NormalizeWindowInput => ({
  id: pickString(entry, ["id"]) ?? key,
  label: pickString(entry, ["label", "name", "title"]),
  kind: "quota",
  usedPercent: pickNumber(entry, ["used_percent", "usedPercent", "used"]),
  remainingPercent: pickNumber(entry, ["remaining_percent", "remainingPercent"]),
  resetsAt: pickNumber(entry, ["resets_at", "resetsAt", "reset_at", "resetAt", "resets", "reset"]),
  durationSeconds: pickNumber(entry, ["duration_seconds", "durationSeconds", "duration", "window_seconds"]),
  limit: pickNumber(entry, ["limit", "total"]),
  remaining: pickNumber(entry, ["remaining", "left"]),
})

const collectEntries = (payload: unknown): Array<{ key: string; entry: Record<string, unknown> }> => {
  if (!isRecord(payload)) return []
  for (const container of ["windows", "limits", "usage"]) {
    const value = payload[container]
    if (Array.isArray(value)) {
      return value
        .filter((item) => isRecord(item))
        .map((entry, index) => ({
          key: pickString(entry, ["id", "label", "name"]) ?? `${container}-${index}`,
          entry,
        }))
    }
  }
  // Object-map shape: { rolling: {...}, weekly: {...}, monthly: {...} }.
  const entries: Array<{ key: string; entry: Record<string, unknown> }> = []
  for (const [key, value] of Object.entries(payload)) {
    if (isRecord(value)) entries.push({ key, entry: value })
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
    windows: entries.map(({ key, entry }) => Banyan.normalizeWindow(toWindowInput(key, entry))),
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
