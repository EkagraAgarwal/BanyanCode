/**
 * Generic rate-limit header normalizer (provider-usage sidebar, Phase 1).
 *
 * Pure function: turns common `x-ratelimit-*` / `anthropic-ratelimit-*`
 * response headers into `reported` rate-limit windows. Header-derived
 * values are current rate limits, not subscription quotas, and are
 * labelled accordingly. No network, no credentials.
 */

import { Banyan } from "@opencode-ai/core/banyancode"

type HeadersLike = Headers | Record<string, string | string[] | undefined>

const get = (headers: HeadersLike, name: string): string | undefined => {
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name)
    return value === null ? undefined : value
  }
  const record = headers as Record<string, string | string[] | undefined>
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name) {
      if (Array.isArray(value)) return value[0]
      return value
    }
  }
  return undefined
}

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

interface HeaderGroup {
  id: string
  label: string
  limitNames: ReadonlyArray<string>
  remainingNames: ReadonlyArray<string>
  resetNames: ReadonlyArray<string>
}

const GROUPS: ReadonlyArray<HeaderGroup> = [
  {
    id: "requests",
    label: "Requests",
    limitNames: ["x-ratelimit-limit-requests", "x-ratelimit-limit", "ratelimit-limit"],
    remainingNames: ["x-ratelimit-remaining-requests", "x-ratelimit-remaining", "ratelimit-remaining"],
    resetNames: ["x-ratelimit-reset-requests", "x-ratelimit-reset", "ratelimit-reset", "retry-after"],
  },
  {
    id: "tokens",
    label: "Tokens",
    limitNames: ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"],
    remainingNames: ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"],
    resetNames: [
      "x-ratelimit-reset-tokens",
      "anthropic-ratelimit-tokens-reset",
      "anthropic-ratelimit-input-tokens-reset",
      "anthropic-ratelimit-output-tokens-reset",
    ],
  },
]

/**
 * Normalize observed rate-limit headers into reported rate-limit windows.
 * Returns an empty array when no usable rate-limit headers are present —
 * the caller then falls back to an `unsupported` snapshot.
 */
export const normalizeRateLimitHeaders = (headers: HeadersLike): Banyan.ProviderUsageWindow[] => {
  const windows: Banyan.ProviderUsageWindow[] = []
  for (const group of GROUPS) {
    const limit = group.limitNames.map((name) => toNumber(get(headers, name))).find((v) => v !== undefined)
    const remaining = group.remainingNames
      .map((name) => toNumber(get(headers, name)))
      .find((v) => v !== undefined)
    const resetRaw = group.resetNames.map((name) => get(headers, name)).find((v) => v !== undefined)
    if (limit === undefined && remaining === undefined) continue
    const usedPercent =
      limit !== undefined && limit > 0 && remaining !== undefined
        ? Banyan.clampPercent(((limit - remaining) / limit) * 100)
        : undefined
    windows.push(
      Banyan.normalizeWindow({
        id: `rate-limit-${group.id}`,
        label: group.label,
        kind: "rate_limit",
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetRaw !== undefined && toNumber(resetRaw) !== undefined
          ? { resetsAt: toNumber(resetRaw) }
          : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
      }),
    )
  }
  return windows
}
