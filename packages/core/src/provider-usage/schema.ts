export * as ProviderUsageSchema from "./schema.js"

import { Schema } from "effect"

/**
 * Normalized provider-usage data model (provider-usage sidebar parity).
 *
 * Port of v1 `packages/core/src/banyancode/provider-usage.ts`. These schemas
 * are the server→plugin contract: adapters normalize provider payloads into a
 * snapshot and never leak credentials, raw headers, or upstream bodies.
 * Percentages are clamped to `0..100`, timestamps are absolute epoch
 * milliseconds, and unknown windows keep their labels — never dropped and
 * never invented.
 */

export const Status = Schema.Literals(["available", "stale", "unsupported", "unauthenticated", "error"])
export type Status = typeof Status.Type

export const Confidence = Schema.Literals(["exact", "reported", "estimated"])
export type Confidence = typeof Confidence.Type

export const WindowKind = Schema.Literals(["quota", "rate_limit"])
export type WindowKind = typeof WindowKind.Type

export interface Window extends Schema.Schema.Type<typeof Window> {}
export const Window = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: WindowKind,
  usedPercent: Schema.optional(Schema.Number),
  remainingPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Number),
  durationSeconds: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
}).annotate({ identifier: "ProviderUsage.Window" })

export interface Balance extends Schema.Schema.Type<typeof Balance> {}
export const Balance = Schema.Struct({
  remaining: Schema.Number,
  currency: Schema.optional(Schema.String),
}).annotate({ identifier: "ProviderUsage.Balance" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  providerID: Schema.String,
  displayName: Schema.String,
  status: Status,
  confidence: Confidence,
  windows: Schema.Array(Window),
  balance: Schema.optional(Balance),
  message: Schema.optional(Schema.String),
  fetchedAt: Schema.Number,
}).annotate({ identifier: "ProviderUsage.Snapshot" })

export interface List extends Schema.Schema.Type<typeof List> {}
export const List = Schema.Struct({
  snapshots: Schema.Array(Snapshot),
}).annotate({ identifier: "ProviderUsage.List" })

/** Default cache TTL: 60 seconds. Adapters may override per provider. */
export const DEFAULT_TTL_MS = 60_000
export const MAX_CONCURRENCY = 4

export const FIVE_HOURS_SECONDS = 18_000
export const DAY_SECONDS = 86_400
export const WEEK_SECONDS = 604_800
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

/** Derive `remainingPercent` from a real reported percentage; never fabricate quota. */
export const remainingFromUsed = (usedPercent: number | undefined): number | undefined => {
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return undefined
  return clampPercent(100 - usedPercent)
}

const SECOND_MS_THRESHOLD = 1_000_000_000_000

/** Normalize a timestamp to absolute epoch milliseconds. */
export const toEpochMs = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return value < SECOND_MS_THRESHOLD ? Math.round(value * 1000) : Math.round(value)
}

export interface NormalizeWindowInput {
  readonly id: string
  readonly label?: string
  readonly kind?: WindowKind
  readonly usedPercent?: number
  readonly remainingPercent?: number
  readonly resetsAt?: number
  readonly durationSeconds?: number
  readonly limit?: number
  readonly remaining?: number
}

/** Normalize one usage window. Never invents a quota. */
export const normalizeWindow = (input: NormalizeWindowInput): Window => {
  const resetsAt = toEpochMs(input.resetsAt)
  const reportedRemaining =
    input.remainingPercent !== undefined && Number.isFinite(input.remainingPercent)
      ? clampPercent(input.remainingPercent)
      : undefined
  const remainingPercent = reportedRemaining ?? remainingFromUsed(input.usedPercent)
  return {
    id: input.id,
    label: input.label ?? labelForDuration(input.durationSeconds) ?? input.id,
    kind: input.kind ?? "quota",
    ...(input.usedPercent !== undefined && Number.isFinite(input.usedPercent)
      ? { usedPercent: clampPercent(input.usedPercent) }
      : {}),
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(input.durationSeconds !== undefined && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? { durationSeconds: input.durationSeconds }
      : {}),
    ...(input.limit !== undefined && Number.isFinite(input.limit) ? { limit: input.limit } : {}),
    ...(input.remaining !== undefined && Number.isFinite(input.remaining) ? { remaining: input.remaining } : {}),
  }
}

/**
 * Strip credentials, authorization headers, account ids, and key-like tokens
 * from any string before it leaves this module. Adapter messages are static,
 * but upstream-supplied detail (e.g. a provider `msg` field) and unexpected
 * defects are attacker-influenced, so every path runs through this.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
  /sk-[A-Za-z0-9\-_]+/g,
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie)(\s*[:=]\s*)\S+/gi,
  /(ChatGPT-Account-Id\s*[:=]\s*)\S+/gi,
]

export const redactSecrets = (message: string): string => {
  let out = message
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix?: string) =>
      typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]",
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
  status: Status,
  fetchedAt: number,
  message?: string,
): Snapshot => ({
  providerID,
  displayName,
  status,
  confidence: "exact",
  windows: [],
  ...(message === undefined ? {} : { message: redactSecrets(message) }),
  fetchedAt,
})

/** Snapshot for a provider with no usable usage source. Never fabricates limits. */
export const unsupportedSnapshot = (
  providerID: string,
  displayName: string,
  fetchedAt: number,
  message = "Usage unavailable",
): Snapshot => baseSnapshot(providerID, displayName, "unsupported", fetchedAt, message)

/** Snapshot for a configured provider whose credentials are absent or expired. */
export const unauthenticatedSnapshot = (providerID: string, displayName: string, fetchedAt: number): Snapshot =>
  baseSnapshot(providerID, displayName, "unauthenticated", fetchedAt, "Not connected")

/** Snapshot for a failed refresh with no previous data. Message is secret-sanitized. */
export const errorSnapshot = (
  providerID: string,
  displayName: string,
  message: string,
  fetchedAt: number,
): Snapshot => baseSnapshot(providerID, displayName, "error", fetchedAt, message)

/** Mark the last successful snapshot stale after a failed refresh; keeps old windows. */
export const markStale = (snapshot: Snapshot): Snapshot => ({ ...snapshot, status: "stale" })

const STATUS_RANK: Record<Status, number> = {
  available: 0,
  stale: 1,
  unauthenticated: 2,
  error: 3,
  unsupported: 4,
}

export const sortSnapshots = (snapshots: ReadonlyArray<Snapshot>): Snapshot[] =>
  [...snapshots].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.displayName.localeCompare(b.displayName),
  )

export const OPENCODE_ALIAS_IDS = ["opencode", "opencode-go"] as const
export const OPENCODE_CANONICAL_ID = "opencode-go"
export const OPENCODE_CANONICAL_NAME = "OpenCode"
export const CODEX_OAUTH_NAME = "ChatGPT"
export const OPENAI_API_NAME = "OpenAI"

/** Fallback display names so raw lowercase provider IDs never reach the UI. */
const BUILT_IN_CANONICAL_NAMES: Record<string, string> = {
  opencode: OPENCODE_CANONICAL_NAME,
  "opencode-go": OPENCODE_CANONICAL_NAME,
  openai: OPENAI_API_NAME,
  "openai-codex": CODEX_OAUTH_NAME,
  codex: CODEX_OAUTH_NAME,
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  gemini: "Gemini",
  "kimi-for-coding": "Kimi",
  moonshotai: "Kimi",
  "zhipuai-coding-plan": "Zhipu",
  zhipu: "Zhipu",
  zhipuai: "Zhipu",
  zai: "Zhipu",
  "minimax-cn-coding-plan": "MiniMax",
  minimax: "MiniMax",
}

export const isOpenCodeAlias = (providerID: string): boolean =>
  (OPENCODE_ALIAS_IDS as readonly string[]).includes(providerID)

/** Collapse `opencode`/`opencode-go` to a single canonical target ID. */
export const canonicalProviderID = (providerID: string): string =>
  isOpenCodeAlias(providerID) ? OPENCODE_CANONICAL_ID : providerID

const isCodexID = (providerID: string): boolean =>
  providerID === "openai" || providerID === "openai-codex" || providerID === "codex"

/** Canonical display name for a usage snapshot. */
export const canonicalDisplayName = (
  providerID: string,
  configuredName?: string,
  authType?: string,
): string => {
  if (isOpenCodeAlias(providerID)) return OPENCODE_CANONICAL_NAME
  if (isCodexID(providerID)) return authType === "oauth" ? CODEX_OAUTH_NAME : OPENAI_API_NAME
  if (configuredName && configuredName.length > 0 && configuredName !== providerID) return configuredName
  return BUILT_IN_CANONICAL_NAMES[providerID] ?? configuredName ?? providerID
}

export const matchesProviderID = (targetID: string, requestedID: string): boolean =>
  targetID === requestedID || canonicalProviderID(targetID) === canonicalProviderID(requestedID)
