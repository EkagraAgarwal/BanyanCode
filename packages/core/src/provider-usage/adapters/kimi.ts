export * as KimiUsage from "./kimi.js"

import { Effect } from "effect"
import { ProviderUsageError } from "../error.js"
import { normalizeWindow, type Snapshot, type Window } from "../schema.js"
import { fromThrow, isRecord, requestJson, toResetsAt } from "./http.js"
import type { Adapter, AdapterContext } from "./types.js"

/**
 * Kimi coding-plan usage adapter (provider-usage sidebar parity).
 *
 * Calls the fixed `GET https://api.kimi.com/coding/v1/usages` endpoint and
 * normalizes the coding-plan windows (typically `5h` plus weekly) into
 * remaining-percent quota windows. Unknown window shapes keep a synthesized
 * label rather than being dropped.
 */

export const PROVIDER_IDS = ["kimi-for-coding", "moonshotai"] as const

const toLooseNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
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
  const total = toLooseNumber(limit)
  const left = toLooseNumber(remaining)
  if (total === undefined || left === undefined || total <= 0) return undefined
  return (left / total) * 100
}

const parseLimitWindow = (value: unknown, index: number): Window | undefined => {
  if (!isRecord(value)) return undefined
  const window = isRecord(value["window"]) ? value["window"] : undefined
  const detail = isRecord(value["detail"]) ? value["detail"] : undefined
  if (!window || !detail) return undefined
  const duration = toLooseNumber(window["duration"])
  const timeUnit = typeof window["timeUnit"] === "string" ? window["timeUnit"] : undefined
  const remainingPercent = percentFromQuota(detail["limit"], detail["remaining"])
  if (remainingPercent === undefined) return undefined
  return normalizeWindow({
    id: `limit-${index}`,
    label: windowLabel(duration, timeUnit),
    kind: "quota",
    remainingPercent,
    resetsAt: toResetsAt(detail["resetTime"]),
    durationSeconds: toDurationSeconds(duration, timeUnit),
  })
}

/** Pure normalizer; throws a secret-safe error on malformed payloads. */
export const normalizeKimiUsage = (
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
  if (!isRecord(payload)) fail("Kimi returned an unrecognized usage payload")
  const root: Record<string, unknown> = isRecord(payload) ? payload : fail("unreachable")
  const windows: Window[] = Array.isArray(root["limits"])
    ? root["limits"]
        .map((item, index) => parseLimitWindow(item, index))
        .filter((item): item is Window => item !== undefined)
    : []
  const usage = isRecord(root["usage"]) ? root["usage"] : undefined
  const topLevelPercent = usage !== undefined ? percentFromQuota(usage["limit"], usage["remaining"]) : undefined
  if (topLevelPercent !== undefined) {
    const topLevel = normalizeWindow({
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
  return {
    providerID: input.providerID,
    displayName: input.displayName,
    status: "available",
    confidence: "exact",
    windows,
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

export const KimiAdapter: Adapter = {
  id: "banyan-usage-kimi",
  providerID: "kimi-for-coding",
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
          message: "Kimi is not connected",
        })
      const payload = yield* requestJson({
        providerID: ctx.providerID,
        fetch: ctx.fetch,
        url: ctx.endpoints.kimi,
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
        label: "Kimi usage",
        unauthorized: "Kimi rejected the API key",
        rateLimited: "Kimi usage rate limited",
        unreadable: "Kimi returned an unreadable usage payload",
      })
      return yield* fromThrow(ctx.providerID, () =>
        normalizeKimiUsage(payload, { providerID: ctx.providerID, displayName: ctx.displayName }),
      )
    }),
}
