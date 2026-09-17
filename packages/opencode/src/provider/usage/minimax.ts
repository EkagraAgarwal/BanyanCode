/**
 * MiniMax coding-plan remains adapter (provider-usage sidebar).
 *
 * Calls `GET https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains`
 * with the Bearer API key and normalizes the interval plus weekly remaining
 * counts into quota windows. International accounts served from
 * `api.minimax.io` use the matching regional remains host; the selection is
 * derived from the provider `baseURL` option.
 *
 * Contract follows the MIT-licensed `xihuai18/opencode-quota-sidebar`
 * minimax-cn-coding-plan adapter: `{ data: { model_remains: [{
 * current_interval_total_count, current_interval_usage_count, start_time,
 * end_time, current_weekly_total_count, current_weekly_usage_count,
 * weekly_start_time, weekly_end_time }] }, base_resp: { status_code,
 * status_msg } }`. The `*_usage_count` fields carry the remaining counts in
 * this contract and are normalized as such.
 */

import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Adapter, AdapterContext } from "../usage"

export const MINIMAX_REMAINS_URL = "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains"
export const MINIMAX_INTL_REMAINS_URL = "https://www.minimax.io/v1/api/openplatform/coding_plan/remains"
export const MINIMAX_PROVIDER_IDS = ["minimax-cn-coding-plan", "minimax"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const toResetsAt = (value: unknown): number | undefined => {
  const numeric = toFiniteNumber(value)
  if (numeric !== undefined) return numeric
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

const remainsUrl = (baseURL: unknown): string => {
  if (typeof baseURL === "string") {
    try {
      if (new URL(baseURL).host === "api.minimax.io") return MINIMAX_INTL_REMAINS_URL
    } catch {
      // Ignore malformed base URLs; fall through to the default host.
    }
  }
  return MINIMAX_REMAINS_URL
}

const percentFromRemaining = (total: unknown, remaining: unknown): number | undefined => {
  const totalValue = toFiniteNumber(total)
  const remainingValue = toFiniteNumber(remaining)
  if (totalValue === undefined || remainingValue === undefined || totalValue <= 0) return undefined
  return (remainingValue / totalValue) * 100
}

const windowDurationSeconds = (startTime: unknown, endTime: unknown): number | undefined => {
  const start = toResetsAt(startTime)
  const end = toResetsAt(endTime)
  if (start === undefined || end === undefined || end <= start) return undefined
  return Math.floor((end - start) / 1000)
}

const windowLabel = (seconds: number | undefined, fallback: string): string => {
  if (seconds === undefined || seconds <= 0) return fallback
  const hours = seconds / 3600
  if (hours <= 24) return `${Math.round(hours)}h`
  if (hours / 24 <= 6) return `${Math.round(hours / 24)}d`
  return "Weekly"
}

const parseWindow = (args: {
  total: unknown
  remaining: unknown
  startTime: unknown
  endTime: unknown
  fallbackLabel: string
  id: string
}): Banyan.ProviderUsageWindow | undefined => {
  const remainingPercent = percentFromRemaining(args.total, args.remaining)
  if (remainingPercent === undefined) return undefined
  const durationSeconds = windowDurationSeconds(args.startTime, args.endTime)
  return Banyan.normalizeWindow({
    id: args.id,
    label: windowLabel(durationSeconds, args.fallbackLabel),
    kind: "quota",
    remainingPercent,
    resetsAt: toResetsAt(args.endTime),
    durationSeconds,
  })
}

/** Pure normalizer; throws a secret-safe ProviderUsageError on malformed payloads. */
export const normalizeMiniMaxRemains = (
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
  if (!isRecord(payload)) fail("MiniMax returned an unrecognized remains payload")
  const root: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  const data = isRecord(root["data"]) ? root["data"] : root
  const baseResp = isRecord(data["base_resp"])
    ? data["base_resp"]
    : isRecord(root["base_resp"])
      ? root["base_resp"]
      : undefined
  const statusCode = baseResp !== undefined ? toFiniteNumber(baseResp["status_code"]) : undefined
  if (statusCode !== undefined && statusCode !== 0) {
    const detail =
      typeof baseResp?.["status_msg"] === "string" && baseResp["status_msg"].length > 0
        ? (baseResp["status_msg"] as string)
        : `status_code ${statusCode}`
    fail(`MiniMax ${detail}`)
  }
  const firstModel =
    Array.isArray(data["model_remains"]) && isRecord(data["model_remains"][0]) ? data["model_remains"][0] : undefined
  if (!firstModel) fail("MiniMax returned no coding-plan remains")
  const model: Record<string, unknown> = isRecord(firstModel) ? firstModel : fail("unreachable")
  const windows = [
    parseWindow({
      total: model["current_interval_total_count"],
      remaining: model["current_interval_usage_count"],
      startTime: model["start_time"],
      endTime: model["end_time"],
      fallbackLabel: "5h",
      id: "interval",
    }),
    parseWindow({
      total: model["current_weekly_total_count"],
      remaining: model["current_weekly_usage_count"],
      startTime: model["weekly_start_time"],
      endTime: model["weekly_end_time"],
      fallbackLabel: "Weekly",
      id: "weekly",
    }),
  ].filter((item): item is Banyan.ProviderUsageWindow => item !== undefined)
  if (windows.length === 0) fail("MiniMax returned no coding-plan remains")
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

export const MiniMaxAdapter: Adapter = {
  id: "banyan-usage-minimax",
  providerID: "minimax-cn-coding-plan",
  refreshIntervalSeconds: 60,
  supports: (input) => (MINIMAX_PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const apiKey = resolveApiKey(ctx)
      if (!apiKey) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "MiniMax is not connected",
        })
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          ctx.fetch(remainsUrl(ctx.options["baseURL"]), {
            method: "GET",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
          }),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "network",
            message: "MiniMax remains request failed",
          }),
      })
      if (response.status === 401 || response.status === 403) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "MiniMax rejected the API key",
        })
      }
      if (response.status === 429) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "rate_limited",
          message: "MiniMax remains rate limited",
        })
      }
      if (!response.ok) {
        return yield* new Banyan.ProviderUsageError({
          providerID: ctx.providerID,
          reason: "upstream",
          message: `MiniMax remains returned status ${response.status}`,
        })
      }
      const payload: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: "MiniMax returned an unreadable remains payload",
          }),
      })
      return normalizeMiniMaxRemains(payload, {
        providerID: ctx.providerID,
        displayName: ctx.displayName,
      })
    }),
}
