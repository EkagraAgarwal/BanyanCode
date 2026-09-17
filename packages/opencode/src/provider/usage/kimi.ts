/**
 * Kimi coding-plan usage adapter (provider-usage sidebar).
 *
 * Calls `GET https://api.kimi.com/coding/v1/usages` with the API key and
 * normalizes the coding-plan windows (typically `5h` plus weekly) into
 * remaining-percent quota windows. Unknown window shapes are preserved with
 * a synthesized label rather than dropped.
 *
 * Contract follows the MIT-licensed `xihuai18/opencode-quota-sidebar`
 * kimi-for-coding adapter: `{ limits: [{ window: { duration, timeUnit },
 * detail: { limit, remaining, resetTime } }], usage: { limit, remaining,
 * resetTime } }`. The base URL is pinned to the vendor endpoint; no
 * speculative per-account region hosts are probed.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const KIMI_USAGES_URL = "https://api.kimi.com/coding/v1/usages"
export const KIMI_PROVIDER_IDS = ["kimi-for-coding", "moonshotai"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
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

const toDurationSeconds = (duration: number | undefined, timeUnit: string | undefined): number | undefined => {
  if (duration === undefined || duration <= 0) return undefined
  if (timeUnit === "TIME_UNIT_MINUTE") return duration * 60
  if (timeUnit === "TIME_UNIT_HOUR") return duration * 3600
  if (timeUnit === "TIME_UNIT_DAY") return duration * 86400
  return undefined
}

const windowLabel = (duration: number | undefined, timeUnit: string | undefined): string => {
  if (timeUnit === "TIME_UNIT_MINUTE" && duration === 300) return "5h"
  if (timeUnit === "TIME_UNIT_DAY" && duration === 7) return "Weekly"
  if (timeUnit === "TIME_UNIT_MINUTE" && duration !== undefined && duration > 0) {
    const hours = duration / 60
    if (hours <= 24) return `${Math.round(hours)}h`
  }
  if (timeUnit === "TIME_UNIT_HOUR" && duration !== undefined && duration > 0) {
    if (duration <= 24) return `${Math.round(duration)}h`
    if (duration / 24 <= 6) return `${Math.round(duration / 24)}d`
  }
  if (timeUnit === "TIME_UNIT_DAY" && duration !== undefined && duration > 0 && duration <= 6) {
    return `${Math.round(duration)}d`
  }
  return "Window"
}

const percentFromQuota = (limit: unknown, remaining: unknown): number | undefined => {
  const total = toFiniteNumber(limit)
  const left = toFiniteNumber(remaining)
  if (total === undefined || left === undefined || total <= 0) return undefined
  return (left / total) * 100
}

const parseLimitWindow = (value: unknown, index: number): Banyan.ProviderUsageWindow | undefined => {
  if (!isRecord(value)) return undefined
  const window = isRecord(value["window"]) ? value["window"] : undefined
  const detail = isRecord(value["detail"]) ? value["detail"] : undefined
  if (!window || !detail) return undefined
  const duration = toFiniteNumber(window["duration"])
  const timeUnit = typeof window["timeUnit"] === "string" ? window["timeUnit"] : undefined
  const remainingPercent = percentFromQuota(detail["limit"], detail["remaining"])
  if (remainingPercent === undefined) return undefined
  return Banyan.normalizeWindow({
    id: `limit-${index}`,
    label: windowLabel(duration, timeUnit),
    kind: "quota",
    remainingPercent,
    resetsAt: toResetsAt(detail["resetTime"]),
    durationSeconds: toDurationSeconds(duration, timeUnit),
  })
}

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeKimiUsage = (
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
  if (!isRecord(payload)) fail("Kimi returned an unrecognized usage payload")
  const root: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  const windows: Banyan.ProviderUsageWindow[] = Array.isArray(root["limits"])
    ? root["limits"]
        .map((item, index) => parseLimitWindow(item, index))
        .filter((item): item is Banyan.ProviderUsageWindow => item !== undefined)
    : []
  const usage = isRecord(root["usage"]) ? root["usage"] : undefined
  const topLevelPercent = usage !== undefined ? percentFromQuota(usage["limit"], usage["remaining"]) : undefined
  if (topLevelPercent !== undefined) {
    const topLevel = Banyan.normalizeWindow({
      id: "usage",
      label: "Weekly",
      kind: "quota",
      remainingPercent: topLevelPercent,
      resetsAt: toResetsAt(usage?.["resetTime"]),
    })
    const duplicate = windows.some(
      (item) =>
        item.label === topLevel.label &&
        item.remainingPercent === topLevel.remainingPercent &&
        item.resetsAt === topLevel.resetsAt,
    )
    if (!duplicate) windows.push(topLevel)
  }
  if (windows.length === 0) fail("Kimi returned no usage windows")
  const rank = (label: string): number => (label === "5h" ? 0 : label === "Weekly" ? 1 : 2)
  windows.sort((a, b) => rank(a.label) - rank(b.label))
  return new Banyan.ProviderUsageSnapshot({
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows,
    fetchedAt: input.fetchedAt ?? Date.now(),
  })
}

const resolveApiKey = (ctx: AdapterContext): string | undefined => {
  const fromOptions = ctx.options["apiKey"]
  if (typeof fromOptions === "string" && fromOptions.length > 0) return fromOptions
  const auth = ctx.auth
  if (!auth) return undefined
  if (auth.type === "api" && auth.key.length > 0) return auth.key
  if (auth.type === "wellknown") {
    if (auth.key.length > 0) return auth.key
    if (auth.token.length > 0) return auth.token
  }
  if (auth.type === "oauth" && auth.access.length > 0) return auth.access
  return undefined
}

export const KimiAdapter: Adapter = {
  id: "banyan-usage-kimi",
  providerID: "kimi-for-coding",
  refreshIntervalSeconds: 60,
  supports: (input) => (KIMI_PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const apiKey = resolveApiKey(ctx)
      if (!apiKey) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Kimi is not connected",
        })
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          ctx.fetch(KIMI_USAGES_URL, {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${apiKey}`,
            },
          }),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "network",
            message: "Kimi usage request failed",
          }),
      })
      if (response.status === 401 || response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "Kimi rejected the API key",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "Kimi usage rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `Kimi usage returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "Kimi returned an unreadable usage payload",
          }),
      })
      return normalizeKimiUsage(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
