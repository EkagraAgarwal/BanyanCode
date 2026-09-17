/**
 * ChatGPT/Codex OAuth usage adapter (provider-usage sidebar, Phase 1).
 *
 * Calls `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth
 * bearer token and `ChatGPT-Account-Id` when available.
 *
 * Real wham contract (verified against the live endpoint):
 * - top-level `rate_limit` with `primary_window` and optional
 *   `secondary_window` (null when the plan enforces a single window);
 * - window fields `used_percent`, optional `remaining_percent`,
 *   `limit_window_seconds`, `reset_at`, `reset_after_seconds`;
 * - top-level `additional_rate_limits[]` with per-model caps (e.g. Spark),
 *   either `{ id, title, primary_window, secondary_window }` or
 *   `{ limit_name, metered_feature, rate_limit: { primary_window, ... } }`.
 * Window type is classified by `limit_window_seconds` (18000 = 5h,
 * 604800 = weekly) — never by `primary`/`secondary` position. Simple
 * legacy `{ limits: {...} }` shapes are still accepted as a fallback.
 *
 * Expired credentials are refreshed once before the usage call via the
 * shared `refreshAndPersistCodexSession` helper (same refresh-token request
 * the `codex.ts` plugin loader uses), persisted via `Auth.Service`, and a
 * `401` from the usage call triggers exactly one refresh-and-retry. `403`
 * and `429` are never retried. All failures stay secret-safe.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Auth } from "@/auth"
import type { Adapter } from "../usage"
import { refreshAndPersistCodexSession } from "../../plugin/openai/codex-refresh"

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
export const CODEX_PROVIDER_IDS = ["openai", "openai-codex", "codex"] as const

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

const toWindowInput = (
  key: string,
  entry: Record<string, unknown>,
  nowMs: number,
): Banyan.NormalizeWindowInput => ({
  id: pickString(entry, ["id"]) ?? key,
  label:
    pickString(entry, ["label", "name", "title"]) ??
    Banyan.labelForDuration(
      pickNumber(entry, [
        "limit_window_seconds",
        "limitWindowSeconds",
        "duration_seconds",
        "durationSeconds",
        "duration",
        "window_seconds",
      ]),
    ),
  kind: "quota",
  usedPercent: normalizePercent(
    pickNumber(entry, ["used_percent", "usedPercent", "used", "utilization"]),
  ),
  remainingPercent: normalizePercent(
    pickNumber(entry, ["remaining_percent", "remainingPercent", "remaining_percentage"]),
  ),
  resetsAt: resolveResetMs(entry, nowMs),
  durationSeconds: pickNumber(entry, [
    "limit_window_seconds",
    "limitWindowSeconds",
    "duration_seconds",
    "durationSeconds",
    "duration",
    "window_seconds",
  ]),
  limit: pickNumber(entry, ["limit", "total", "allowance"]),
  remaining: pickNumber(entry, ["remaining", "left", "balance"]),
})

/** Fractional `0..1` percentages are ratios; scale to `0..100`. Clamping happens later. */
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

const hasUsablePercent = (entry: Record<string, unknown>): boolean =>
  toFiniteNumber(entry["used_percent"]) !== undefined ||
  toFiniteNumber(entry["usedPercent"]) !== undefined ||
  toFiniteNumber(entry["used"]) !== undefined ||
  toFiniteNumber(entry["remaining_percent"]) !== undefined ||
  toFiniteNumber(entry["remainingPercent"]) !== undefined

const windowDuration = (entry: Record<string, unknown>): number | undefined =>
  pickNumber(entry, [
    "limit_window_seconds",
    "limitWindowSeconds",
    "duration_seconds",
    "durationSeconds",
    "duration",
    "window_seconds",
  ])

const toRealWindowInput = (
  id: string,
  label: string,
  window: unknown,
  nowMs: number,
): Banyan.NormalizeWindowInput | undefined => {
  if (!isRecord(window)) return undefined
  if (!hasUsablePercent(window)) return undefined
  const durationSeconds = windowDuration(window)
  const durationLabel = Banyan.labelForDuration(durationSeconds)
  return {
    id,
    label: durationLabel && label !== durationLabel ? label : (label ?? durationLabel),
    kind: "quota",
    usedPercent: normalizePercent(
      pickNumber(window, ["used_percent", "usedPercent", "used", "utilization"]),
    ),
    remainingPercent: normalizePercent(
      pickNumber(window, ["remaining_percent", "remainingPercent", "remaining_percentage"]),
    ),
    resetsAt: resolveResetMs(window, nowMs),
    durationSeconds,
  } as Banyan.NormalizeWindowInput
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
  const haystack = [
    pickString(entry, ["limit_name", "id", "title", "name", "label"]),
    metered,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
  return SPARK_NAME_PATTERN.test(haystack)
}

/** Split an `additional_rate_limits` entry into its primary/secondary windows. */
const additionalWindows = (
  entry: Record<string, unknown>,
): { primary: unknown; secondary: unknown } => {
  const nested = entry["rate_limit"]
  if (isRecord(nested)) {
    if ("primary_window" in nested || "secondary_window" in nested) {
      return { primary: nested["primary_window"], secondary: nested["secondary_window"] }
    }
    return { primary: nested, secondary: undefined }
  }
  return { primary: entry["primary_window"], secondary: entry["secondary_window"] }
}

/**
 * Parse the verified real wham shape. Returns usable quota windows only:
 * null/unusable windows are skipped, and unknown metered features are
 * included only when the entry carries a safe human label.
 */
const parseWhamPayload = (payload: Record<string, unknown>, nowMs: number): Array<Banyan.NormalizeWindowInput> => {
  const out: Array<Banyan.NormalizeWindowInput> = []
  const rateLimit = payload["rate_limit"]
  if (isRecord(rateLimit)) {
    const durationLabel = (window: unknown, fallback: string): string => {
      if (!isRecord(window)) return fallback
      return Banyan.labelForDuration(windowDuration(window)) ?? fallback
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
        isRecord(primary) && windowDuration(primary) !== undefined
          ? Banyan.labelForDuration(windowDuration(primary))
          : undefined
      const baseLabel =
        title ?? (spark && primaryDuration ? `Spark ${primaryDuration}` : spark ? "Spark" : rawName)
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
      const durationLabel = isRecord(window) ? Banyan.labelForDuration(windowDuration(window)) : undefined
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

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeCodexUsage = (
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
  if (!isRecord(payload)) fail("ChatGPT returned an unrecognized usage payload")
  const record = payload as Record<string, unknown>
  const nowMs = input.fetchedAt ?? Date.now()
  const wham = parseWhamPayload(record, nowMs)
  if (wham.length > 0) {
    return new Banyan.ProviderUsageSnapshot({
      providerID: input.providerID,
      displayName: input.displayName,
      status: "available",
      confidence: "exact",
      windows: wham.map((window) => Banyan.normalizeWindow(window)),
      fetchedAt: nowMs,
    })
  }
  const entries = collectEntries(payload)
  if (entries.length === 0) fail("ChatGPT returned no usage windows")
  return new Banyan.ProviderUsageSnapshot({
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows: entries.map(({ key, entry }) => Banyan.normalizeWindow(toWindowInput(key, entry, nowMs))),
    fetchedAt: nowMs,
  })
}

export const CodexAdapter: Adapter = {
  id: "banyan-usage-openai-codex",
  providerID: "openai",
  refreshIntervalSeconds: 60,
  supports: (input) =>
    (CODEX_PROVIDER_IDS as readonly string[]).includes(input.providerID) &&
    (input.authType === "oauth" || !input.hasAuth),
  fetch: (ctx) =>
    Effect.gen(function* () {
      const current = ctx.auth
      if (current?.type !== "oauth") {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "ChatGPT is not connected with OAuth",
        })
      }
      let access = current.access
      let accountId = current.accountId
      let refreshToken = current.refresh
      const issuer = typeof ctx.options.codexIssuer === "string" ? ctx.options.codexIssuer : undefined
      const persist = (session: { access: string; refresh: string; expires: number; accountId?: string }) =>
        ctx.persistAuth
          ? ctx.persistAuth(
              ctx.providerID,
              new Auth.Oauth({
                type: "oauth",
                refresh: session.refresh,
                access: session.access,
                expires: session.expires,
                ...(session.accountId ? { accountId: session.accountId } : {}),
              }),
            )
          : Effect.void
      const refreshOnce = Effect.fn("CodexUsage.refresh")(function* () {
        const session = yield* refreshAndPersistCodexSession({
          providerID: ctx.providerID,
          refreshToken,
          previousAccountId: accountId,
          issuer,
          fetchImpl: ctx.fetch,
          persist,
        })
        access = session.access
        accountId = session.accountId
        refreshToken = session.refresh
      })
      if (current.expires < Date.now()) {
        yield* refreshOnce()
      }
      const requestUsage = Effect.fn("CodexUsage.request")(function* () {
        const headers: Record<string, string> = {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
        }
        if (accountId) headers["ChatGPT-Account-Id"] = accountId
        return yield* Effect.tryPromise({
          try: () => ctx.fetch(CODEX_USAGE_URL, { method: "GET", headers }),
          catch: () =>
            new Banyan.ProviderUsageError({
              providerID: ctx.providerID,
              reason: "network",
              message: "ChatGPT usage request failed",
            }),
        })
      })
      let response = yield* requestUsage()
      if (response.status === 401) {
        // The bearer was rejected: refresh exactly once and retry once.
        yield* refreshOnce()
        response = yield* requestUsage()
        if (response.status === 401) {
          return yield* new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "unauthenticated",
            message: "ChatGPT rejected the session — re-authenticate to refresh usage",
          })
        }
      }
      if (response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "ChatGPT rejected the session — re-authenticate to refresh usage",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "ChatGPT usage rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `ChatGPT usage returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "ChatGPT returned an unreadable usage payload",
          }),
      })
      return normalizeCodexUsage(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
