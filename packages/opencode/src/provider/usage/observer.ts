/**
 * Process-local rate-limit observation store (provider-usage sidebar, Phase 3).
 *
 * The provider runtime observes response headers from actual configured
 * provider model HTTP calls and records only normalized numeric/reset values
 * via `normalizeRateLimitHeaders`. Raw headers, bodies, and credentials are
 * never stored. Entries are keyed by provider plus account so one account
 * cannot see another's limits.
 *
 * This module intentionally depends only on the normalizer and core schemas:
 * it must not import `../usage` (ProviderUsage service) or `../provider`
 * (Provider service), otherwise a ProviderUsage<->Provider cycle forms.
 */

import { createHash } from "node:crypto"
import { Banyan } from "@opencode-ai/core/banyancode"
import { normalizeRateLimitHeaders } from "./rate-limit-headers"

export const OBSERVER_UNKNOWN_ACCOUNT = "unknown"
export const OBSERVER_DEFAULT_TTL_MS = 60_000

export interface ObservedRateLimit {
  readonly providerID: string
  readonly accountKey: string
  readonly windows: Banyan.ProviderUsageWindow[]
  readonly observedAt: number
}

const store = new Map<string, ObservedRateLimit>()

// NOTE: the separator is the NUL escape (`\u0000`), written as source-text so
// this file stays plain ASCII. A literal NUL byte in the source makes
// Git/read tools classify this module as binary.
export const observerKeyFor = (providerID: string, accountKey: string): string =>
  `${providerID}\u0000${accountKey}`

/** Fingerprint an API key without storing it raw. Mirrors usage `accountKeyFor`. */
export const fingerprintApiKey = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex").slice(0, 16)

/** Derive the observer account key from a raw API key, or unknown when absent. */
export const accountKeyForApiKey = (apiKey: string | undefined): string =>
  apiKey && apiKey.length > 0 ? `key:${fingerprintApiKey(apiKey)}` : OBSERVER_UNKNOWN_ACCOUNT

type HeadersLike = Headers | Record<string, string | string[] | undefined>

export interface ObserveOptions {
  readonly accountKey?: string
  readonly now?: number
}

/**
 * Observe one provider HTTP response. Reads headers only - never touches the
 * body - and stores normalized windows. Returns true when an entry was
 * recorded, false when headers carried no usable rate-limit data or the
 * response was missing. Never throws.
 */
export const observeRateLimitResponse = (
  providerID: string,
  headers: HeadersLike | undefined,
  opts: ObserveOptions = {},
): boolean => {
  try {
    if (!providerID || !headers) return false
    const windows = normalizeRateLimitHeaders(headers)
    if (windows.length === 0) return false
    const accountKey = opts.accountKey ?? OBSERVER_UNKNOWN_ACCOUNT
    const observedAt = opts.now ?? Date.now()
    // Store normalized windows only: numbers, ids, labels, epoch-ms resets.
    // No raw headers, no credentials, no bodies.
    const snapshot = windows.map((window) =>
      Banyan.normalizeWindow({
        id: window.id,
        label: window.label,
        kind: "rate_limit",
        ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
        ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
        ...(window.limit !== undefined ? { limit: window.limit } : {}),
        ...(window.remaining !== undefined ? { remaining: window.remaining } : {}),
      }),
    )
    store.set(observerKeyFor(providerID, accountKey), { providerID, accountKey, windows: snapshot, observedAt })
    return true
  } catch {
    return false
  }
}

export interface ReadOptions {
  readonly ttlMs?: number
  readonly now?: number
}

/** Read a fresh observation for an exact provider/account pair. Stale entries are dropped. */
export const readObservedRateLimit = (
  providerID: string,
  accountKey: string,
  opts: ReadOptions = {},
): ObservedRateLimit | undefined => {
  const entry = store.get(observerKeyFor(providerID, accountKey))
  if (!entry) return undefined
  const ttlMs = opts.ttlMs ?? OBSERVER_DEFAULT_TTL_MS
  const now = opts.now ?? Date.now()
  if (!Banyan.isFresh(entry.observedAt, now, ttlMs)) {
    store.delete(observerKeyFor(providerID, accountKey))
    return undefined
  }
  return entry
}

/**
 * Partition hygiene: drop every observation for `providerID` that does not
 * belong to `currentAccountKey`. Call on account switches and before serving
 * a snapshot so a new account never reads the previous account's limits.
 */
export const pruneObservationsForAccount = (providerID: string, currentAccountKey: string): void => {
  for (const [key, entry] of store) {
    if (entry.providerID === providerID && entry.accountKey !== currentAccountKey) store.delete(key)
  }
}

/** Explicit invalidation. No args clears everything (tests, sign-out). */
export const clearObservations = (providerID?: string, accountKey?: string): void => {
  if (providerID === undefined) {
    store.clear()
    return
  }
  for (const [key, entry] of store) {
    if (entry.providerID !== providerID) continue
    if (accountKey !== undefined && entry.accountKey !== accountKey) continue
    store.delete(key)
  }
}

/** Test seam: entry count. */
export const observedCount = (): number => store.size
