export * as CodexUsage from "./openai-codex.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import {
  labelForDuration,
  normalizeWindow,
  type NormalizeWindowInput,
  type Snapshot,
} from "../schema.js"
import { fromThrow, isRecord, requestJson, toFiniteNumber } from "./http.js"
import type { Adapter } from "./types.js"

/**
 * ChatGPT/Codex OAuth usage adapter (provider-usage sidebar parity).
 *
 * Calls the fixed `GET https://chatgpt.com/backend-api/wham/usage` endpoint
 * with the OAuth bearer token and `ChatGPT-Account-Id` when the access token
 * carries one. Window type is classified by `limit_window_seconds` — never by
 * `primary`/`secondary` position.
 *
 * Refresh difference from v1: v1 refreshed an expired Codex session inside
 * the adapter and persisted it. v2 centralizes OAuth refresh in
 * `Integration.connection.resolve` (which refreshes before returning an
 * expiring OAuth credential and persists it under the credential lock), so
 * this adapter only reads the credential it is handed. A `401` from the usage
 * call is terminal here instead of triggering a second refresh-and-retry.
 */

export const PROVIDER_IDS = ["openai", "openai-codex", "codex"] as const

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

const DURATION_NAMES = [
  "limit_window_seconds",
  "limitWindowSeconds",
  "duration_seconds",
  "durationSeconds",
  "duration",
  "window_seconds",
] as const

/** Fractional `0..1` percentages are ratios; scale to `0..100`. */
const normalizePercent = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (value > 0 && value < 1) return value * 100
  return value
}

const RESET_AFTER_NAMES = [
  "reset_after_seconds",
  "resetAfterSeconds",
  "reset_after",
  "resetAfter",
  "resets_in_seconds",
] as const

const RESET_AT_NAMES = [
  "reset_at",
  "resetAt",
  "resets_at",
  "resetsAt",
  "resets",
  "reset",
] as const

/** Prefer the absolute reset; derive from `reset_after_seconds` off `nowMs` when absent. */
const resolveResetMs = (entry: Record<string, unknown>, nowMs: number): number | undefined => {
  const absolute = pickNumber(entry, [...RESET_AT_NAMES])
  if (absolute !== undefined) return absolute
  const after = pickNumber(entry, [...RESET_AFTER_NAMES])
  if (after !== undefined && Number.isFinite(after) && after >= 0) return nowMs + after * 1000
  return undefined
}

const toWindowInput = (
  key: string,
  entry: Record<string, unknown>,
  nowMs: number,
): NormalizeWindowInput => ({
  id: pickString(entry, ["id"]) ?? key,
  label: pickString(entry, ["label", "name", "title"]) ?? labelForDuration(pickNumber(entry, [...DURATION_NAMES])),
  kind: "quota",
  usedPercent: normalizePercent(pickNumber(entry, ["used_percent", "usedPercent", "used", "utilization"])),
  remainingPercent: normalizePercent(
    pickNumber(entry, ["remaining_percent", "remainingPercent", "remaining_percentage"]),
  ),
  resetsAt: resolveResetMs(entry, nowMs),
  durationSeconds: pickNumber(entry, [...DURATION_NAMES]),
  limit: pickNumber(entry, ["limit", "total", "allowance"]),
  remaining: pickNumber(entry, ["remaining", "left", "balance"]),
})

const hasUsablePercent = (entry: Record<string, unknown>): boolean =>
  toFiniteNumber(entry["used_percent"]) !== undefined ||
  toFiniteNumber(entry["usedPercent"]) !== undefined ||
  toFiniteNumber(entry["used"]) !== undefined ||
  toFiniteNumber(entry["remaining_percent"]) !== undefined ||
  toFiniteNumber(entry["remainingPercent"]) !== undefined

const windowDuration = (entry: Record<string, unknown>): number | undefined =>
  pickNumber(entry, [...DURATION_NAMES])

const toRealWindowInput = (
  id: string,
  label: string,
  window: unknown,
  nowMs: number,
): NormalizeWindowInput | undefined => {
  if (!isRecord(window)) return undefined
  if (!hasUsablePercent(window)) return undefined
  const durationSeconds = windowDuration(window)
  const durationLabel = labelForDuration(durationSeconds)
  return {
    id,
    label: durationLabel && label !== durationLabel ? label : (label ?? durationLabel),
    kind: "quota",
    usedPercent: normalizePercent(pickNumber(window, ["used_percent", "usedPercent", "used", "utilization"])),
    remainingPercent: normalizePercent(
      pickNumber(window, ["remaining_percent", "remainingPercent", "remaining_percentage"]),
    ),
    resetsAt: resolveResetMs(window, nowMs),
    durationSeconds,
  }
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

const SPARK_METERED_FEATURE = "codex_bengalfox"
const SPARK_NAME_PATTERN = /codex[-_ ]?spark/i

const isSparkEntry = (entry: Record<string, unknown>): boolean => {
  const metered = pickString(entry, ["metered_feature", "meteredFeature"])
  if (metered === SPARK_METERED_FEATURE) return true
  const haystack = [pickString(entry, ["limit_name", "id", "title", "name", "label"]), metered]
    .filter((part) => part !== undefined)
    .join(" ")
  return SPARK_NAME_PATTERN.test(haystack)
}

/** Split an `additional_rate_limits` entry into its primary/secondary windows. */
const additionalWindows = (entry: Record<string, unknown>): { primary: unknown; secondary: unknown } => {
  const nested = entry["rate_limit"]
  if (isRecord(nested)) {
    if ("primary_window" in nested || "secondary_window" in nested)
      return { primary: nested["primary_window"], secondary: nested["secondary_window"] }
    return { primary: nested, secondary: undefined }
  }
  return { primary: entry["primary_window"], secondary: entry["secondary_window"] }
}

/** Parse the verified real wham shape. Returns usable quota windows only. */
const parseWhamPayload = (payload: Record<string, unknown>, nowMs: number): NormalizeWindowInput[] => {
  const out: NormalizeWindowInput[] = []
  const rateLimit = payload["rate_limit"]
  if (isRecord(rateLimit)) {
    const durationLabel = (window: unknown, fallback: string): string => {
      if (!isRecord(window)) return fallback
      return labelForDuration(windowDuration(window)) ?? fallback
    }
    const primary = toRealWindowInput(
      "primary",
      durationLabel(rateLimit["primary_window"], "Primary"),
      rateLimit["primary_window"],
      nowMs,
    )
    if (primary) out.push(primary)
    const secondary = toRealWindowInput(
      "secondary",
      durationLabel(rateLimit["secondary_window"], "Secondary"),
      rateLimit["secondary_window"],
      nowMs,
    )
    if (secondary) out.push(secondary)
  }
  const additional = payload["additional_rate_limits"]
  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      if (!isRecord(item)) return
      const spark = isSparkEntry(item)
      const safeLabel = pickString(item, ["title", "label", "limit_name", "name"])
      if (!spark && safeLabel === undefined) return
      const rawName = pickString(item, ["limit_name", "id", "title", "name"]) ?? `additional-${index}`
      const baseId = spark ? "spark" : slugify(rawName) || `additional-${index}`
      const title = pickString(item, ["title", "label", "limit_name", "name"])
      const { primary, secondary } = additionalWindows(item)
      const primaryDuration =
        isRecord(primary) && windowDuration(primary) !== undefined ? labelForDuration(windowDuration(primary)) : undefined
      const baseLabel = title ?? (spark && primaryDuration ? `Spark ${primaryDuration}` : spark ? "Spark" : rawName)
      const primaryInput = toRealWindowInput(baseId, baseLabel, primary, nowMs)
      if (primaryInput) out.push(primaryInput)
      const secondaryInput = toRealWindowInput(
        `${baseId}-secondary`,
        `${baseLabel} (secondary)`,
        secondary,
        nowMs,
      )
      if (secondaryInput) out.push(secondaryInput)
    })
  }
  const codeReview = payload["code_review_rate_limit"]
  if (isRecord(codeReview)) {
    const primary = isRecord(codeReview["primary_window"]) ? codeReview["primary_window"] : codeReview
    const secondary = codeReview["secondary_window"]
    const labelFor = (window: unknown): string => {
      const durationLabel = isRecord(window) ? labelForDuration(windowDuration(window)) : undefined
      return durationLabel ? `Code review ${durationLabel}` : "Code review"
    }
    const primaryInput = toRealWindowInput("code-review", labelFor(primary), primary, nowMs)
    if (primaryInput) out.push(primaryInput)
    const secondaryInput = toRealWindowInput(
      "code-review-secondary",
      `${labelFor(secondary)} (secondary)`,
      secondary,
      nowMs,
    )
    if (secondaryInput) out.push(secondaryInput)
  }
  return out
}

const collectEntries = (payload: unknown): Array<{ key: string; entry: Record<string, unknown> }> => {
  if (!isRecord(payload)) return []
  const containers = ["limits", "windows", "usage", "quotas", "additional_limits", "additionalLimits"]
  for (const container of containers) {
    const value = payload[container]
    if (Array.isArray(value)) {
      return value
        .filter((item) => isRecord(item))
        .map((entry, index) => ({
          key: pickString(entry, ["id", "label", "name"]) ?? `${container}-${index}`,
          entry,
        }))
    }
    if (isRecord(value)) {
      return Object.entries(value).map(([key, item]) => ({
        key,
        entry: isRecord(item) ? item : { used_percent: item },
      }))
    }
  }
  return []
}

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeCodexUsage = (
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
  if (!isRecord(payload)) fail("ChatGPT returned an unrecognized usage payload")
  const record = payload as Record<string, unknown>
  const nowMs = input.fetchedAt ?? Date.now()
  const wham = parseWhamPayload(record, nowMs)
  if (wham.length > 0) {
    return {
      providerID: input.providerID,
      displayName: input.displayName,
      status: "available",
      confidence: "exact",
      windows: wham.map((window) => normalizeWindow(window)),
      fetchedAt: nowMs,
    }
  }
  const entries = collectEntries(payload)
  if (entries.length === 0) fail("ChatGPT returned no usage windows")
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: entries.map(({ key, entry }) => normalizeWindow(toWindowInput(key, entry, nowMs))),
    fetchedAt: nowMs,
  }
}

/**
 * `ChatGPT-Account-Id` from the JWT claims of the access token. The token is
 * read but never copied, logged, or stored; only the account id leaves this
 * function, and it is used as a request header.
 */
const accountID = (access: string): string | undefined => {
  const part = access.split(".")[1]
  if (!part) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, "base64url").toString())
    if (!isRecord(claims)) return undefined
    const nested = claims["https://api.openai.com/auth"]
    if (typeof claims["chatgpt_account_id"] === "string") return claims["chatgpt_account_id"]
    if (isRecord(nested) && typeof nested["chatgpt_account_id"] === "string") return nested["chatgpt_account_id"]
    const organizations = claims["organizations"]
    if (Array.isArray(organizations) && isRecord(organizations[0]) && typeof organizations[0]["id"] === "string")
      return organizations[0]["id"]
    return undefined
  } catch {
    return undefined
  }
}

export const CodexAdapter: Adapter = {
  id: "banyan-usage-openai-codex",
  providerID: "openai",
  refreshIntervalSeconds: 60,
  supports: (input) =>
    (PROVIDER_IDS as readonly string[]).includes(input.providerID) &&
    (input.authType === "oauth" || !input.hasAuth),
  fetch: (ctx) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      if (credential?.type !== "oauth")
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "ChatGPT is not connected with OAuth",
        })
      const headers: Record<string, string> = {
        authorization: `Bearer ${credential.access}`,
        "content-type": "application/json",
      }
      const account = accountID(credential.access)
      if (account) headers["ChatGPT-Account-Id"] = account
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: ctx.endpoints.chatgpt,
        headers,
        label: "ChatGPT usage",
        unauthorized: "ChatGPT rejected the session — re-authenticate to refresh usage",
        rateLimited: "ChatGPT usage rate limited",
        unreadable: "ChatGPT returned an unreadable usage payload",
      })
      return yield* fromThrow(ctx.providerID, () =>
        normalizeCodexUsage(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
