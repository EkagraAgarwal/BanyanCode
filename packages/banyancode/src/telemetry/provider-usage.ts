import { Effect, Schema } from "effect"

/**
 * Provider usage (`GET /global/provider-usage` parity).
 *
 * Port of v1 `packages/core/src/banyancode/provider-usage.ts` plus the
 * observer/rate-limit normalizer from
 * `packages/opencode/src/provider/usage/{rate-limit-headers,observer}.ts`.
 *
 * Scope note: the v1 adapters that call provider APIs need credentials, and
 * the v2 plugin API exposes no auth surface, so this port serves the part the
 * plugin can honestly observe: rate-limit headers from live model responses
 * (`ctx.session.hook("http.response")`). A provider with a fresh observation
 * reports `available` + `reported` windows; every other provider is
 * `unsupported` ("Usage unavailable"), never an invented quota. `message`
 * fields are secret-sanitized before they leave the plugin.
 */

export const DURATION_CLASSES = ["five_hour", "daily", "weekly", "monthly", "unknown"] as const

export const ProviderUsageWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["quota", "rate_limit"]),
  usedPercent: Schema.optional(Schema.Number),
  remainingPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Number),
  durationSeconds: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
}).annotate({ identifier: "Banyan.ProviderUsageWindow" })

export type ProviderUsageWindow = typeof ProviderUsageWindow.Type

export const ProviderUsageSnapshot = Schema.Struct({
  providerID: Schema.String,
  displayName: Schema.String,
  status: Schema.Literals(["available", "stale", "unsupported", "unauthenticated", "error"]),
  confidence: Schema.Literals(["exact", "reported", "estimated"]),
  windows: Schema.Array(ProviderUsageWindow),
  balance: Schema.optional(
    Schema.Struct({
      remaining: Schema.Number,
      currency: Schema.optional(Schema.String),
    }),
  ),
  message: Schema.optional(Schema.String),
  fetchedAt: Schema.Number,
}).annotate({ identifier: "Banyan.ProviderUsageSnapshot" })

export type ProviderUsageSnapshot = typeof ProviderUsageSnapshot.Type

export const ProviderUsageList = Schema.Struct({
  snapshots: Schema.Array(ProviderUsageSnapshot),
}).annotate({ identifier: "Banyan.ProviderUsageList" })

export type ProviderUsageList = typeof ProviderUsageList.Type

export const PROVIDER_USAGE_DEFAULT_TTL_MS = 60_000
export const OBSERVER_DEFAULT_TTL_MS = 60_000
export const FIVE_HOURS_SECONDS = 18_000
export const DAY_SECONDS = 86_400
export const WEEK_SECONDS = 604_800
export const MONTH_SECONDS_MIN = 2_419_200
export const MONTH_SECONDS_MAX = 2_678_400

export type DurationClass = (typeof DURATION_CLASSES)[number]

export const classifyDuration = (seconds: number | undefined): DurationClass => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "unknown"
  if (seconds === FIVE_HOURS_SECONDS) return "five_hour"
  if (seconds === DAY_SECONDS) return "daily"
  if (seconds === WEEK_SECONDS) return "weekly"
  if (seconds >= MONTH_SECONDS_MIN && seconds <= MONTH_SECONDS_MAX) return "monthly"
  return "unknown"
}

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

export const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export const remainingFromUsed = (usedPercent: number | undefined): number | undefined => {
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return undefined
  return clampPercent(100 - usedPercent)
}

const SECOND_MS_THRESHOLD = 1_000_000_000_000

export const toEpochMs = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return value < SECOND_MS_THRESHOLD ? Math.round(value * 1000) : Math.round(value)
}

export interface NormalizeWindowInput {
  readonly id: string
  readonly label?: string
  readonly kind?: "quota" | "rate_limit"
  readonly usedPercent?: number
  readonly remainingPercent?: number
  readonly resetsAt?: number
  readonly durationSeconds?: number
  readonly limit?: number
  readonly remaining?: number
}

/** Never invents a quota: percentages are clamped, labels fall back to the id. */
export const normalizeWindow = (input: NormalizeWindowInput): ProviderUsageWindow => {
  const resetsAt = toEpochMs(input.resetsAt)
  const remainingPercent =
    input.remainingPercent !== undefined && Number.isFinite(input.remainingPercent)
      ? clampPercent(input.remainingPercent)
      : remainingFromUsed(input.usedPercent)
  return {
    id: input.id,
    label: input.label ?? labelForDuration(input.durationSeconds) ?? input.id,
    kind: input.kind ?? "quota",
    ...(input.usedPercent !== undefined && Number.isFinite(input.usedPercent)
      ? { usedPercent: clampPercent(input.usedPercent) }
      : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(input.durationSeconds !== undefined && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? { durationSeconds: input.durationSeconds }
      : {}),
    ...(input.limit !== undefined && Number.isFinite(input.limit) ? { limit: input.limit } : {}),
    ...(input.remaining !== undefined && Number.isFinite(input.remaining) ? { remaining: input.remaining } : {}),
  }
}

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

export const isFresh = (fetchedAt: number, now: number, ttlMs: number): boolean =>
  Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt < ttlMs

export const unsupportedSnapshot = (providerID: string, displayName: string, now: number): ProviderUsageSnapshot => ({
  providerID,
  displayName,
  status: "unsupported",
  confidence: "exact",
  windows: [],
  message: "Usage unavailable",
  fetchedAt: now,
})

// ── observed rate-limit headers ────────────────────────────────────────────

type HeadersLike = Headers | Record<string, string | string[] | undefined>

const header = (headers: HeadersLike, name: string): string | undefined => {
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

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const RATE_LIMIT_GROUPS = [
  {
    id: "requests",
    label: "Requests",
    limit: ["x-ratelimit-limit-requests", "x-ratelimit-limit", "ratelimit-limit"],
    remaining: ["x-ratelimit-remaining-requests", "x-ratelimit-remaining", "ratelimit-remaining"],
    reset: ["x-ratelimit-reset-requests", "x-ratelimit-reset", "ratelimit-reset", "retry-after"],
  },
  {
    id: "tokens",
    label: "Tokens",
    limit: ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"],
    remaining: ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"],
    reset: [
      "x-ratelimit-reset-tokens",
      "anthropic-ratelimit-tokens-reset",
      "anthropic-ratelimit-input-tokens-reset",
      "anthropic-ratelimit-output-tokens-reset",
    ],
  },
] as const

export const normalizeRateLimitHeaders = (headers: HeadersLike): ProviderUsageWindow[] =>
  RATE_LIMIT_GROUPS.flatMap((group) => {
    const limit = group.limit.map((name) => number(header(headers, name))).find((value) => value !== undefined)
    const remaining = group.remaining
      .map((name) => number(header(headers, name)))
      .find((value) => value !== undefined)
    const reset = group.reset.map((name) => header(headers, name)).find((value) => value !== undefined)
    if (limit === undefined && remaining === undefined) return []
    const usedPercent =
      limit !== undefined && limit > 0 && remaining !== undefined ? clampPercent(((limit - remaining) / limit) * 100) : undefined
    const resetsAt = number(reset)
    return [
      normalizeWindow({
        id: `rate-limit-${group.id}`,
        label: group.label,
        kind: "rate_limit",
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
      }),
    ]
  })

export interface ObservedRateLimit {
  readonly providerID: string
  readonly windows: ReadonlyArray<ProviderUsageWindow>
  readonly observedAt: number
}

const observations = new Map<string, ObservedRateLimit>()

/** Test seam: drop every observation. */
export const resetObservations = (): void => {
  observations.clear()
}

/** Reads response headers only — never the body, never credentials. */
export const observeRateLimitResponse = (
  providerID: string,
  headers: HeadersLike | undefined,
  now = Date.now(),
): boolean => {
  try {
    if (providerID.length === 0 || headers === undefined) return false
    const windows = normalizeRateLimitHeaders(headers)
    if (windows.length === 0) return false
    observations.set(providerID, { providerID, windows, observedAt: now })
    return true
  } catch {
    return false
  }
}

export const readObservedRateLimit = (
  providerID: string,
  now = Date.now(),
  ttlMs = OBSERVER_DEFAULT_TTL_MS,
): ObservedRateLimit | undefined => {
  const observed = observations.get(providerID)
  if (observed === undefined) return undefined
  if (!isFresh(observed.observedAt, now, ttlMs)) {
    observations.delete(providerID)
    return undefined
  }
  return observed
}

// ── collector ──────────────────────────────────────────────────────────────

export interface ProviderLike {
  readonly id: string
  readonly name: string
}

export interface ProviderUsageDeps {
  readonly providers: () => Effect.Effect<ReadonlyArray<ProviderLike>, unknown>
  /**
   * Result-only quota lookup served by the core credential boundary
   * (`ctx.provider.usage`). The plugin passes a filter and a cache flag and
   * receives sanitized windows; it never supplies or receives a credential,
   * URL, header, or request callback.
   */
  readonly usage?: (input?: {
    readonly force?: boolean
    readonly providerID?: string
  }) => Effect.Effect<{ readonly snapshots: ReadonlyArray<ProviderUsageSnapshot> }, unknown>
  readonly now?: () => number
  readonly ttlMs?: number
}

export interface ProviderUsage {
  readonly snapshots: (input?: { readonly force?: boolean; readonly providerID?: string }) => Effect.Effect<ProviderUsageList>
}

// `opencode` and `opencode-go` are one panel row (v1 alias rule).
const OPENCODE_ALIASES = ["opencode", "opencode-go"] as const
const isOpenCodeAlias = (providerID: string) => (OPENCODE_ALIASES as readonly string[]).includes(providerID)
const sameProvider = (a: string, b: string) =>
  a === b || (isOpenCodeAlias(a) && isOpenCodeAlias(b))

/** Decode the core seam result; a malformed row is dropped rather than shown. */
const coreSnapshots = (
  usage: ProviderUsageDeps["usage"],
  input: { readonly force?: boolean; readonly providerID?: string },
): Effect.Effect<ReadonlyArray<ProviderUsageSnapshot>, never, never> => {
  if (usage === undefined) return Effect.succeed([])
  return usage(input).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(Schema.Array(ProviderUsageSnapshot))(result.snapshots),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<ProviderUsageSnapshot>),
  )
}

/** Overlay observed rate-limit headers on a provider with no exact quota source. */
const observedSnapshot = (providerID: string, displayName: string, at: number, ttlMs: number) => {
  const observed = readObservedRateLimit(providerID, at, ttlMs)
  if (observed === undefined || observed.windows.length === 0) return undefined
  return {
    providerID,
    displayName,
    status: "available",
    confidence: "reported",
    windows: observed.windows.map((window) =>
      normalizeWindow({
        id: window.id,
        label: window.label,
        kind: "rate_limit",
        ...(window.usedPercent === undefined ? {} : { usedPercent: window.usedPercent }),
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        ...(window.limit === undefined ? {} : { limit: window.limit }),
        ...(window.remaining === undefined ? {} : { remaining: window.remaining }),
      }),
    ),
    fetchedAt: observed.observedAt,
  } satisfies ProviderUsageSnapshot
}

export const makeProviderUsage = (deps: ProviderUsageDeps): ProviderUsage => {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? PROVIDER_USAGE_DEFAULT_TTL_MS
  let cache: { readonly at: number; readonly snapshots: ReadonlyArray<ProviderUsageSnapshot> } | undefined

  const collect = (input?: { readonly force?: boolean; readonly providerID?: string }) =>
    Effect.gen(function* () {
      const at = now()
      const providerID = input?.providerID
      const [core, providers] = yield* Effect.all(
        [
          coreSnapshots(deps.usage, {
            ...(input?.force === true ? { force: true } : {}),
            ...(providerID === undefined ? {} : { providerID }),
          }),
          deps.providers().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ProviderLike>)),
        ],
        { concurrency: 2 },
      )
      const filtered = (provider: ProviderLike) =>
        providerID === undefined || sameProvider(provider.id, providerID)
      const merged = new Map<string, ProviderUsageSnapshot>()
      for (const snapshot of core) {
        // Exact core quotas win. Only a provider core knows nothing about is
        // eligible for the header-derived fallback — never a fabricated quota.
        if (snapshot.status !== "unsupported") {
          merged.set(snapshot.providerID, snapshot)
          continue
        }
        const observed = observedSnapshot(snapshot.providerID, snapshot.displayName, at, ttlMs)
        merged.set(snapshot.providerID, observed ?? snapshot)
      }
      // Providers the core seam did not report (unconfigured catalog entries)
      // keep the pre-existing panel row instead of disappearing.
      for (const provider of providers.filter(filtered)) {
        if ([...merged.keys()].some((key) => sameProvider(key, provider.id))) continue
        merged.set(
          provider.id,
          observedSnapshot(provider.id, provider.name, at, ttlMs) ??
            unsupportedSnapshot(provider.id, provider.name, at),
        )
      }
      return [...merged.values()]
    })

  const snapshots = (input?: { readonly force?: boolean; readonly providerID?: string }) =>
    Effect.gen(function* () {
      const at = now()
      const providerID = input?.providerID
      const cached = cache && providerID === undefined && !input?.force && isFresh(cache.at, at, ttlMs) ? cache : undefined
      if (cached !== undefined) return { snapshots: [...cached.snapshots] }
      const collected = yield* collect(input)
      if (providerID === undefined && input?.force !== true) cache = { at, snapshots: collected }
      return { snapshots: [...collected] }
    })

  return { snapshots }
}
