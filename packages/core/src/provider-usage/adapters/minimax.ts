export * as MiniMaxUsage from "./minimax.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import { normalizeWindow, type Snapshot, type Window } from "../schema.js"
import { fromThrow, isRecord, requestJson, toFiniteNumber, toResetsAt } from "./http.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * MiniMax coding-plan remains adapter (provider-usage sidebar parity).
 *
 * Calls the fixed
 * `GET https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains`
 * endpoint with the Bearer API key. International accounts served from
 * `api.minimax.io` use the matching regional remains host, selected from the
 * provider `settings.baseURL` host — never from caller input.
 */

export const PROVIDER_IDS = ["minimax-cn-coding-plan", "minimax"] as const

const remainsUrl = (ctx: AdapterContext): string => {
  const baseURL = ctx.settings?.baseURL
  if (typeof baseURL === "string") {
    try {
      if (new URL(baseURL).host === "api.minimax.io") return ctx.endpoints.minimaxIntl
    } catch {
      // Ignore malformed base URLs; fall through to the default host.
    }
  }
  return ctx.endpoints.minimax
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
}): Window | undefined => {
  const remainingPercent = percentFromRemaining(args.total, args.remaining)
  if (remainingPercent === undefined) return undefined
  const durationSeconds = windowDurationSeconds(args.startTime, args.endTime)
  return normalizeWindow({
    id: args.id,
    label: windowLabel(durationSeconds, args.fallbackLabel),
    kind: "quota",
    remainingPercent,
    resetsAt: toResetsAt(args.endTime),
    durationSeconds,
  })
}

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeMiniMaxRemains = (
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
  ].filter((item): item is Window => item !== undefined)
  if (windows.length === 0) fail("MiniMax returned no coding-plan remains")
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows,
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

export const MiniMaxAdapter: Adapter = {
  id: "banyan-usage-minimax",
  providerID: "minimax-cn-coding-plan",
  refreshIntervalSeconds: 60,
  supports: (input) => (PROVIDER_IDS as readonly string[]).includes(input.providerID),
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const credential = yield* ctx.credential()
      const apiKey =
        credential?.type === "key" && credential.key.length > 0
          ? credential.key
          : credential?.type === "oauth" && credential.access.length > 0
            ? credential.access
            : undefined
      if (!apiKey)
        return yield* new ProviderUsageError({
          providerID: ctx.providerID,
          reason: "unauthenticated",
          message: "MiniMax is not connected",
        })
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: remainsUrl(ctx),
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        label: "MiniMax remains",
        unauthorized: "MiniMax rejected the API key",
        rateLimited: "MiniMax remains rate limited",
        unreadable: "MiniMax returned an unreadable remains payload",
      })
      return yield* fromThrow(ctx.providerID, () =>
        normalizeMiniMaxRemains(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
