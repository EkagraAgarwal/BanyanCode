export * as ProviderUsageRateLimits from "./rate-limits.js"

import { clampPercent, normalizeWindow, type Window } from "./schema.js"

/**
 * Generic rate-limit header normalizer (provider-usage sidebar parity).
 *
 * Pure function: turns common `x-ratelimit-*` / `anthropic-ratelimit-*`
 * response headers into `reported` rate-limit windows. Header-derived values
 * are current rate limits, not subscription quotas. No network, no
 * credentials — this module is safe to feed raw response headers.
 */

type HeadersLike = Headers | Record<string, string | string[] | undefined>

const get = (headers: HeadersLike, name: string): string | undefined => {
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name)
    return value === null ? undefined : value
  }
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

interface HeaderGroup {
  readonly id: string
  readonly label: string
  readonly limitNames: ReadonlyArray<string>
  readonly remainingNames: ReadonlyArray<string>
  readonly resetNames: ReadonlyArray<string>
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

/** Returns an empty array when no usable rate-limit headers are present. */
export const normalizeRateLimitHeaders = (headers: HeadersLike): Window[] =>
  GROUPS.flatMap((group) => {
    const limit = group.limitNames.map((name) => toNumber(get(headers, name))).find((value) => value !== undefined)
    const remaining = group.remainingNames
      .map((name) => toNumber(get(headers, name)))
      .find((value) => value !== undefined)
    if (limit === undefined && remaining === undefined) return []
    const usedPercent =
      limit !== undefined && limit > 0 && remaining !== undefined
        ? clampPercent(((limit - remaining) / limit) * 100)
        : undefined
    const reset = group.resetNames.map((name) => toNumber(get(headers, name))).find((value) => value !== undefined)
    return [
      normalizeWindow({
        id: `rate-limit-${group.id}`,
        label: group.label,
        kind: "rate_limit",
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(reset === undefined ? {} : { resetsAt: reset }),
        ...(limit === undefined ? {} : { limit }),
        ...(remaining === undefined ? {} : { remaining }),
      }),
    ]
  })
