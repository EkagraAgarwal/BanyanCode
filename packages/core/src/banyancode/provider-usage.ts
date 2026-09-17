/**
 * Normalized provider-usage data model (provider-usage sidebar, Phase 1).
 *
 * These schemas are the server→client contract: adapters normalize
 * provider-specific payloads into `ProviderUsageSnapshot` and never leak
 * credentials, raw headers, or raw upstream bodies. Percentages are clamped
 * to `0..100`, timestamps are absolute epoch milliseconds, and unknown
 * windows are preserved with provider-supplied labels — never dropped and
 * never invented.
 */

import { Schema } from "effect"

export const ProviderUsageStatusSchema = Schema.Literals([
  "available",
  "stale",
  "unsupported",
  "unauthenticated",
  "error",
])
export type ProviderUsageStatus = Schema.Schema.Type<typeof ProviderUsageStatusSchema>

export const ProviderUsageConfidenceSchema = Schema.Literals(["exact", "reported", "estimated"])
export type ProviderUsageConfidence = Schema.Schema.Type<typeof ProviderUsageConfidenceSchema>

export const ProviderUsageWindowKindSchema = Schema.Literals(["quota", "rate_limit"])
export type ProviderUsageWindowKind = Schema.Schema.Type<typeof ProviderUsageWindowKindSchema>

export class ProviderUsageWindow extends Schema.Class<ProviderUsageWindow>("Banyan/ProviderUsageWindow")({
  id: Schema.String,
  label: Schema.String,
  kind: ProviderUsageWindowKindSchema,
  usedPercent: Schema.optional(Schema.Number),
  remainingPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Number),
  durationSeconds: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
}) {}

export class ProviderUsageBalance extends Schema.Class<ProviderUsageBalance>("Banyan/ProviderUsageBalance")({
  remaining: Schema.Number,
  currency: Schema.optional(Schema.String),
}) {}

export class ProviderUsageSnapshot extends Schema.Class<ProviderUsageSnapshot>("Banyan/ProviderUsageSnapshot")({
  providerID: Schema.String,
  displayName: Schema.String,
  status: ProviderUsageStatusSchema,
  confidence: ProviderUsageConfidenceSchema,
  windows: Schema.Array(ProviderUsageWindow),
  balance: Schema.optional(ProviderUsageBalance),
  message: Schema.optional(Schema.String),
  fetchedAt: Schema.Number,
}) {}

export class ProviderUsageError extends Schema.TaggedErrorClass<ProviderUsageError>()(
  "Banyan/ProviderUsageError",
  {
    providerID: Schema.String,
    reason: Schema.Literals(["unauthenticated", "rate_limited", "upstream", "unsupported", "network"]),
    message: Schema.String,
    retryAfterMs: Schema.optional(Schema.Number),
  },
) {}

/** Default cache TTL: 60 seconds. Adapters may override per provider. */
export const PROVIDER_USAGE_DEFAULT_TTL_MS = 60_000

/** Max concurrent provider refreshes. */
export const PROVIDER_USAGE_MAX_CONCURRENCY = 4

/** Well-known window durations in seconds. `18_000` is five hours, `604_800` is one week. */
export const FIVE_HOURS_SECONDS = 18_000
export const DAY_SECONDS = 86_400
export const WEEK_SECONDS = 604_800
/** Monthly windows vary by provider (28–31 days); match by range, not exactly. */
export const MONTH_SECONDS_MIN = 2_419_200
export const MONTH_SECONDS_MAX = 2_678_400

export type DurationClass = "five_hour" | "daily" | "weekly" | "monthly" | "unknown"

/** Classify a window by its reported duration. Never assume `primary` means five hours. */
export const classifyDuration = (seconds: number | undefined): DurationClass => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "unknown"
  if (seconds === FIVE_HOURS_SECONDS) return "five_hour"
  if (seconds === DAY_SECONDS) return "daily"
  if (seconds === WEEK_SECONDS) return "weekly"
  if (seconds >= MONTH_SECONDS_MIN && seconds <= MONTH_SECONDS_MAX) return "monthly"
  return "unknown"
}

/** Short sidebar label for a well-known duration; undefined for unknown durations. */
export const labelForDuration = (seconds: number | undefined): string | undefined => {
  switch (classifyDuration(seconds)) {
    case "five_hour":
      return "5h"
    case "daily":
      return "24h"
    case "weekly":
      return "1w"
    case "monthly":
      return "1mo"
    case "unknown":
      return undefined
  }
}

/** Clamp a percentage to `0..100`. Non-finite input becomes 0. */
export const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * Derive `remainingPercent` from a real reported `usedPercent`.
 * Returns undefined when the provider did not report a real percentage —
 * callers must not fabricate quota from local counts.
 */
export const remainingFromUsed = (usedPercent: number | undefined): number | undefined => {
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return undefined
  return clampPercent(100 - usedPercent)
}

const SECOND_MS_THRESHOLD = 1_000_000_000_000

/**
 * Normalize a timestamp to absolute epoch milliseconds. Values below 1e12
 * are treated as epoch seconds; larger values are already milliseconds.
 * Returns undefined for missing/non-finite/non-positive input.
 */
export const toEpochMs = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return value < SECOND_MS_THRESHOLD ? Math.round(value * 1000) : Math.round(value)
}

export interface NormalizeWindowInput {
  id: string
  label?: string
  kind?: ProviderUsageWindowKind
  usedPercent?: number
  remainingPercent?: number
  resetsAt?: number
  durationSeconds?: number
  limit?: number
  remaining?: number
}

/**
 * Normalize one usage window: clamp percentages, derive `remainingPercent`
 * only from a real reported `usedPercent`, normalize reset timestamps to
 * epoch milliseconds, and keep the provider-supplied label for unknown
 * durations. Never invent a quota.
 */
export const normalizeWindow = (input: NormalizeWindowInput): ProviderUsageWindow =>
  new ProviderUsageWindow({
    id: input.id,
    label: input.label ?? labelForDuration(input.durationSeconds) ?? input.id,
    kind: input.kind ?? "quota",
    ...(input.usedPercent !== undefined && Number.isFinite(input.usedPercent)
      ? { usedPercent: clampPercent(input.usedPercent) }
      : {}),
    ...(() => {
      if (input.remainingPercent !== undefined && Number.isFinite(input.remainingPercent)) {
        return { remainingPercent: clampPercent(input.remainingPercent) }
      }
      const derived = remainingFromUsed(input.usedPercent)
      return derived === undefined ? {} : { remainingPercent: derived }
    })(),
    ...(toEpochMs(input.resetsAt) !== undefined ? { resetsAt: toEpochMs(input.resetsAt) } : {}),
    ...(input.durationSeconds !== undefined && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? { durationSeconds: input.durationSeconds }
      : {}),
    ...(input.limit !== undefined && Number.isFinite(input.limit) ? { limit: input.limit } : {}),
    ...(input.remaining !== undefined && Number.isFinite(input.remaining) ? { remaining: input.remaining } : {}),
  })

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
  /sk-[A-Za-z0-9\-_]+/g,
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)(\s*[:=]\s*)\S+/gi,
  /(ChatGPT-Account-Id\s*[:=]\s*)\S+/gi,
]

/**
 * Strip credentials, authorization headers, account ids, and key-like
 * tokens from an error/message string before it leaves the server.
 * Never returns raw upstream bodies — callers pass short messages only.
 */
export const redactSecrets = (message: string): string => {
  let out = message
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix?: string) =>
      prefix !== undefined ? `${prefix}[redacted]` : "[redacted]",
    )
  }
  return out
}

/** True when the cached snapshot is still within its TTL. */
export const isFresh = (fetchedAt: number, now: number, ttlMs: number): boolean =>
  Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt < ttlMs

const baseSnapshot = (
  providerID: string,
  displayName: string,
  status: ProviderUsageStatus,
  message?: string,
): ProviderUsageSnapshot =>
  new ProviderUsageSnapshot({
    providerID,
    displayName,
    status,
    confidence: "exact",
    windows: [],
    ...(message !== undefined ? { message: redactSecrets(message) } : {}),
    fetchedAt: Date.now(),
  })

/** Snapshot for a provider with no usable usage source. Never fabricates limits. */
export const unsupportedSnapshot = (providerID: string, displayName: string): ProviderUsageSnapshot =>
  baseSnapshot(providerID, displayName, "unsupported", "Usage unavailable")

/** Snapshot for a configured provider whose credentials are absent or expired. */
export const unauthenticatedSnapshot = (providerID: string, displayName: string): ProviderUsageSnapshot =>
  baseSnapshot(providerID, displayName, "unauthenticated", "Not connected")

/** Snapshot for a failed refresh with no previous data. Message is secret-sanitized. */
export const errorSnapshot = (
  providerID: string,
  displayName: string,
  message: string,
): ProviderUsageSnapshot => baseSnapshot(providerID, displayName, "error", message)

/** Mark the last successful snapshot stale after a failed refresh; keeps old windows. */
export const markStale = (snapshot: ProviderUsageSnapshot): ProviderUsageSnapshot =>
  new ProviderUsageSnapshot({ ...snapshot, status: "stale", fetchedAt: snapshot.fetchedAt })
