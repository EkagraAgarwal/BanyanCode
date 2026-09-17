export * as ProviderUsage from "./usage"

import { Cause, Clock, Context, Deferred, Effect, Layer, Ref } from "effect"
import { createHash } from "node:crypto"
import { Banyan } from "@opencode-ai/core/banyancode"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Auth } from "@/auth"
import { Provider } from "./provider"
import { OpenCodeGoAdapter } from "./usage/opencode-go"
import { CodexAdapter } from "./usage/openai-codex"
import { OpenRouterAdapter } from "./usage/openrouter"
import { AnthropicAdapter } from "./usage/anthropic"
import { CopilotAdapter } from "./usage/github-copilot"
import { KimiAdapter } from "./usage/kimi"
import { ZhipuAdapter } from "./usage/zhipu"
import { MiniMaxAdapter } from "./usage/minimax"
import { GenericRateLimitAdapter } from "./usage/generic-rate-limit"

export interface Interface {
  readonly snapshots: () => Effect.Effect<Banyan.ProviderUsageSnapshot[]>
  readonly refresh: (providerID?: string) => Effect.Effect<Banyan.ProviderUsageSnapshot[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderUsage") {}

export const use = serviceUse(Service)

/** Authenticated request capability handed to adapters. Credentials never leave the server. */
export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface AdapterInput {
  readonly providerID: string
  readonly hasAuth: boolean
  readonly authType?: string
}

export interface AdapterContext {
  readonly providerID: string
  readonly displayName: string
  readonly auth: Auth.Info | undefined
  readonly options: Record<string, unknown>
  readonly accountKey: string
  readonly fetch: FetchImpl
  /**
   * Best-effort credential persistence. Adapters that refresh OAuth tokens
   * (e.g. Codex) call this once per successful refresh so the new session
   * survives restarts. Implemented by the service via `Auth.Service.set`;
   * absent in tests that stub adapters without refresh.
   */
  readonly persistAuth?: (providerID: string, info: Auth.Info) => Effect.Effect<void, unknown>
}

export interface Adapter {
  readonly id: string
  readonly providerID: string
  readonly refreshIntervalSeconds: number
  readonly supports: (input: AdapterInput) => boolean
  readonly fetch: (
    ctx: AdapterContext,
  ) => Effect.Effect<Banyan.ProviderUsageSnapshot, Banyan.ProviderUsageError>
}

const BUILT_IN_ADAPTERS: ReadonlyArray<Adapter> = [
  OpenCodeGoAdapter,
  CodexAdapter,
  OpenRouterAdapter,
  AnthropicAdapter,
  CopilotAdapter,
  KimiAdapter,
  ZhipuAdapter,
  MiniMaxAdapter,
  // Generic header fallback stays last so exact adapters win.
  GenericRateLimitAdapter,
]

/**
 * Process-local adapter registry. Built-in and third-party providers
 * register here without touching the registry implementation; executable
 * adapter code is never accepted over HTTP or configuration JSON.
 */
const customAdapters: Adapter[] = []

export const registerUsageAdapter = (adapter: Adapter): void => {
  const index = customAdapters.findIndex((item) => item.id === adapter.id)
  if (index >= 0) customAdapters[index] = adapter
  else customAdapters.push(adapter)
}

/**
 * Remove a process-local custom adapter by id. Used by the plugin sync
 * when a provider hook stops supplying an adapter (unload/removal) so no
 * stale registration survives. Built-ins are unaffected. Returns true
 * when an entry was removed.
 */
export const unregisterUsageAdapter = (id: string): boolean => {
  const index = customAdapters.findIndex((item) => item.id === id)
  if (index < 0) return false
  customAdapters.splice(index, 1)
  return true
}

/** Test seam: drop all process-local custom adapters. */
export const resetUsageAdapters = (): void => {
  customAdapters.length = 0
}

export const listAdapters = (): ReadonlyArray<Adapter> => [...customAdapters, ...BUILT_IN_ADAPTERS]

export interface Options {
  readonly fetchImpl?: FetchImpl
  readonly defaultTtlMs?: number
}

export const OPENCODE_ALIAS_IDS = ["opencode", "opencode-go"] as const
export const OPENCODE_CANONICAL_ID = "opencode-go"
export const OPENCODE_CANONICAL_NAME = "OpenCode"

export const CODEX_OAUTH_NAME = "ChatGPT"
export const OPENAI_API_NAME = "OpenAI"

/** Fallback display names so raw lowercase provider IDs never reach the UI. */
const BUILT_IN_CANONICAL_NAMES: Record<string, string> = {
  "opencode": OPENCODE_CANONICAL_NAME,
  "opencode-go": OPENCODE_CANONICAL_NAME,
  "openai": OPENAI_API_NAME,
  "openai-codex": CODEX_OAUTH_NAME,
  "codex": CODEX_OAUTH_NAME,
  "anthropic": "Anthropic",
  "openrouter": "OpenRouter",
  "github-copilot": "GitHub Copilot",
  "gemini": "Gemini",
  "kimi-for-coding": "Kimi",
  "moonshotai": "Kimi",
  "zhipuai-coding-plan": "Zhipu",
  "zhipu": "Zhipu",
  "zhipuai": "Zhipu",
  "zai": "Zhipu",
  "minimax-cn-coding-plan": "MiniMax",
  "minimax": "MiniMax",
}

export const isOpenCodeAlias = (providerID: string): boolean =>
  (OPENCODE_ALIAS_IDS as readonly string[]).includes(providerID)

/** Collapse `opencode`/`opencode-go` to a single canonical target ID. */
export const canonicalProviderID = (providerID: string): string =>
  isOpenCodeAlias(providerID) ? OPENCODE_CANONICAL_ID : providerID

const isCodexID = (providerID: string): boolean =>
  providerID === "openai" || providerID === "openai-codex" || providerID === "codex"

/**
 * Canonical display name for a usage snapshot.
 * - `opencode`/`opencode-go` always render as `OpenCode`.
 * - Codex IDs render as `ChatGPT` for OAuth and `OpenAI` for API-key/rate-limit.
 * - Custom provider names (configured name differs from the ID) are preserved.
 * - Otherwise fall back to the built-in canonical map so raw lowercase IDs
 *   never reach the UI when a built-in name is known.
 */
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

interface Target {
  readonly providerID: string
  readonly displayName: string
  readonly auth: Auth.Info | undefined
  readonly options: Record<string, unknown>
  readonly accountKey: string
  readonly adapter: Adapter | undefined
}

interface CacheEntry {
  readonly snapshot: Banyan.ProviderUsageSnapshot
  readonly ttlMs: number
}

const defaultFetch: FetchImpl = (input, init) => fetch(input, init)

const fingerprint = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex").slice(0, 16)

/**
 * Per-provider/account cache identity so account switches never reuse
 * another account's snapshot. API keys are hashed, never stored raw.
 */
export const accountKeyFor = (auth: Auth.Info | undefined): string => {
  if (!auth) return "none"
  if (auth.type === "oauth") return `oauth:${auth.accountId ?? "unknown"}`
  if (auth.type === "api") return `key:${fingerprint(auth.key)}`
  return "wellknown"
}

const cacheKeyFor = (target: Target): string => `${target.providerID} ${target.accountKey}`

const STATUS_RANK: Record<Banyan.ProviderUsageStatus, number> = {
  available: 0,
  stale: 1,
  unauthenticated: 2,
  error: 3,
  unsupported: 4,
}

export const sortSnapshots = (
  snapshots: ReadonlyArray<Banyan.ProviderUsageSnapshot>,
): Banyan.ProviderUsageSnapshot[] =>
  [...snapshots].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.displayName.localeCompare(b.displayName),
  )

const withFetchedAt = (snapshot: Banyan.ProviderUsageSnapshot, fetchedAt: number) =>
  new Banyan.ProviderUsageSnapshot({ ...snapshot, fetchedAt })

export const layerWithOptions = (
  options: Options = {},
): Layer.Layer<Service, never, Auth.Service | Provider.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const provider = yield* Provider.Service
      const scope = yield* Effect.scope
      const fetchImpl = options.fetchImpl ?? defaultFetch
      const defaultTtlMs = options.defaultTtlMs ?? Banyan.PROVIDER_USAGE_DEFAULT_TTL_MS
      const cache = yield* Ref.make(new Map<string, CacheEntry>())
      const backoffUntil = yield* Ref.make(new Map<string, number>())
      const inflight = yield* Ref.make(new Map<string, Deferred.Deferred<Banyan.ProviderUsageSnapshot>>())

      const authFor = (providerID: string, auths: Record<string, Auth.Info>): Auth.Info | undefined => {
        const direct = auths[providerID]
        if (direct) return direct
        // Legacy fallback: `opencode` and `opencode-go` share credentials.
        if (providerID === "opencode") return auths["opencode-go"]
        if (providerID === "opencode-go") return auths["opencode"]
        return undefined
      }

      /**
       * Ephemeral API auth for environment/config-keyed providers. When a
       * provider carries `options.apiKey` (config) or `key` (single-env-var)
       * but has no Auth entry, synthesize an in-memory `Auth.Api` so adapters
       * — including the generic header fallback — match on the same
       * fingerprinted account key the provider runtime used at capture time
       * (see `accountKeyForApiKey` in `usage/observer`). Priority mirrors the
       * runtime capture: config `options.apiKey` first, then `info.key`.
       * Never persisted via `Auth.Service.set`; never stored raw (cache keys
       * and snapshots carry only the fingerprint).
       */
      const ephemeralApiAuth = (info: Provider.Info | undefined): Auth.Info | undefined => {
        const fromOptions =
          info && typeof info.options["apiKey"] === "string" && info.options["apiKey"].length > 0
            ? (info.options["apiKey"] as string)
            : undefined
        const rawKey =
          fromOptions ?? (typeof info?.key === "string" && info.key.length > 0 ? info.key : undefined)
        if (!rawKey) return undefined
        return new Auth.Api({ type: "api", key: rawKey })
      }

      // Discovery reads only explicitly configured/connected providers:
      // active Auth entries plus initialized Provider entries (config,
      // custom, and environment-authenticated). The ModelsDev catalog is
      // never enumerated. The TUI additionally backfills the active session
      // provider client-side, so a provider disabled after its session started
      // is still represented instead of silently dropped.
      const discover = (): Effect.Effect<Target[], never, never> =>
        Effect.all(
          [
            auth.all().pipe(Effect.catchCause(() => Effect.succeed({} as Record<string, Auth.Info>))),
            provider.list().pipe(Effect.catchCause(() => Effect.succeed({} as Record<string, Provider.Info>))),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([auths, providers]) => {
            const byID = new Map<string, Provider.Info>(Object.entries(providers))
            const ids = new Set<string>([...Object.keys(auths), ...byID.keys()])
            if (process.env.OPENCODE_API_KEY) ids.add("opencode")
            // `opencode` and `opencode-go` share credentials: merge both option
            // sets so the Go adapter sees each config leg regardless of which id
            // the target carries (spec credential precedence).
            const optionsFor = (providerID: string): Record<string, unknown> => {
              const own = byID.get(providerID)?.options ?? {}
              if (isOpenCodeAlias(providerID)) {
                const siblingID = providerID === "opencode" ? "opencode-go" : "opencode"
                const sibling = byID.get(siblingID)?.options ?? {}
                return { ...sibling, ...own }
              }
              return { ...(own ?? {}) }
            }
            // Collapse alias IDs to one canonical target so the API never
            // emits duplicated snapshots (e.g. `opencode` + `opencode-go`).
            const grouped = new Map<string, string[]>()
            for (const providerID of ids) {
              const canonical = canonicalProviderID(providerID)
              const group = grouped.get(canonical) ?? []
              group.push(providerID)
              grouped.set(canonical, group)
            }
            const targets: Target[] = []
            for (const [canonicalID, members] of grouped) {
              if (canonicalID === OPENCODE_CANONICAL_ID) {
                // Deterministic alias precedence, independent of map
                // insertion order: env > opencode-go config > opencode
                // config > opencode-go auth > opencode auth.
                const goInfo = byID.get("opencode-go")
                const legacyInfo = byID.get("opencode")
                const mergedOptions = { ...(legacyInfo?.options ?? {}), ...(goInfo?.options ?? {}) }
                // Cache identity must track the credential the adapter will
                // actually send (`resolveOpenCodeGoApiKey`: env, then merged
                // config apiKey, then auth key), so ephemeral Auth.Api
                // entries for env/config keys come before stored auth:
                // switching the used key changes the accountKey even when
                // stored auth is unchanged. Ephemeral keys are in-memory
                // only — hashed into the accountKey, never persisted via
                // `Auth.Service.set` (the Go adapter never calls persistAuth).
                const envKey = process.env.OPENCODE_API_KEY
                const effective =
                  (envKey && envKey.length > 0 ? new Auth.Api({ type: "api", key: envKey }) : undefined) ??
                  ephemeralApiAuth(goInfo) ??
                  ephemeralApiAuth(legacyInfo) ??
                  auths["opencode-go"] ??
                  auths["opencode"]
                const displayName = canonicalDisplayName(
                  canonicalID,
                  goInfo?.name ?? legacyInfo?.name,
                  effective?.type,
                )
                targets.push({
                  providerID: canonicalID,
                  displayName,
                  auth: effective,
                  options: mergedOptions,
                  accountKey: accountKeyFor(effective),
                  adapter: listAdapters().find((item) =>
                    item.supports({
                      providerID: canonicalID,
                      hasAuth: effective !== undefined,
                      authType: effective?.type,
                    }),
                  ),
                })
                continue
              }
              for (const providerID of members) {
                const info = byID.get(providerID)
                const stored = authFor(providerID, auths)
                const effective = stored ?? ephemeralApiAuth(info)
                targets.push({
                  providerID,
                  displayName: canonicalDisplayName(providerID, info?.name, effective?.type),
                  auth: effective,
                  options: optionsFor(providerID),
                  accountKey: accountKeyFor(effective),
                  adapter: listAdapters().find((item) =>
                    item.supports({
                      providerID,
                      hasAuth: effective !== undefined,
                      authType: effective?.type,
                    }),
                  ),
                })
              }
            }
            return targets
          }),
        )

      const errorToSnapshot = (
        target: Target,
        cause: Cause.Cause<unknown>,
        now: number,
      ): Effect.Effect<Banyan.ProviderUsageSnapshot, never, never> =>
        Effect.gen(function* () {
          const cached = (yield* Ref.get(cache)).get(cacheKeyFor(target))?.snapshot
          // catchCause hands us the full Cause; unwrap the typed failure.
          const failure = Cause.findErrorOption(cause)
          const error =
            failure._tag === "Some" && failure.value instanceof Banyan.ProviderUsageError
              ? failure.value
              : undefined
          if (!error) {
            const message = Banyan.redactSecrets(Cause.pretty(cause))
            if (cached) return Banyan.markStale(cached)
            return Banyan.errorSnapshot(target.providerID, target.displayName, message || "Usage request failed")
          }
          switch (error.reason) {
            case "unauthenticated":
              return Banyan.unauthenticatedSnapshot(target.providerID, target.displayName)
            case "unsupported":
              return Banyan.unsupportedSnapshot(target.providerID, target.displayName)
            case "rate_limited": {
              const retryAfter = error.retryAfterMs ?? 60_000
              yield* Ref.update(backoffUntil, (prev) => new Map(prev).set(cacheKeyFor(target), now + retryAfter))
              if (cached) return Banyan.markStale(cached)
              return Banyan.errorSnapshot(target.providerID, target.displayName, error.message)
            }
            case "network":
            case "upstream":
              if (cached) return Banyan.markStale(cached)
              return Banyan.errorSnapshot(target.providerID, target.displayName, error.message)
          }
        })

      const runRefresh = (target: Target): Effect.Effect<Banyan.ProviderUsageSnapshot, never, never> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const key = cacheKeyFor(target)
          if (!target.adapter) return Banyan.unsupportedSnapshot(target.providerID, target.displayName)
          const ttlMs = target.adapter.refreshIntervalSeconds * 1000 || defaultTtlMs
          const fetched = yield* target.adapter
            .fetch({
              providerID: target.providerID,
              displayName: target.displayName,
              auth: target.auth,
              options: target.options,
              accountKey: target.accountKey,
              fetch: fetchImpl,
              persistAuth: (providerID, info) => auth.set(providerID, info),
            })
            .pipe(
              Effect.timeout("15 seconds"),
              Effect.catchCause((cause) => errorToSnapshot(target, cause, now)),
            )
        // Adapter failures already surface as stale/error snapshots via
        // errorToSnapshot. Only successful snapshots refresh the cache;
        // degraded views are cached when no previous success exists so
        // concurrent readers share them until the next attempt.
        if (fetched.status === "available") {
          const snapshot = withFetchedAt(fetched, now)
          yield* Ref.update(cache, (prev) => new Map(prev).set(key, { snapshot, ttlMs }))
          yield* Ref.update(backoffUntil, (prev) => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          })
          return snapshot
        }
        const existing = (yield* Ref.get(cache)).get(key)
        if (!existing) {
          yield* Ref.update(cache, (prev) => new Map(prev).set(key, { snapshot: fetched, ttlMs }))
        }
        return fetched
      })

      // Deduplicate concurrent refreshes per provider/account: joiners await
      // the in-flight deferred instead of firing a second upstream request.
      const refreshOne = (
        target: Target,
      ): Effect.Effect<Banyan.ProviderUsageSnapshot, never, never> =>
        Effect.gen(function* () {
          const key = cacheKeyFor(target)
          const now = yield* Clock.currentTimeMillis
          const until = (yield* Ref.get(backoffUntil)).get(key)
          if (until !== undefined && now < until) {
            const cached = (yield* Ref.get(cache)).get(key)?.snapshot
            if (cached) return cached
            return Banyan.errorSnapshot(target.providerID, target.displayName, "Usage rate limited")
          }
          const existing = (yield* Ref.get(inflight)).get(key)
          if (existing) return yield* Deferred.await(existing)
          const deferred = yield* Deferred.make<Banyan.ProviderUsageSnapshot>()
          yield* Ref.update(inflight, (prev) => new Map(prev).set(key, deferred))
          const drop = Ref.update(inflight, (prev) => {
            const next = new Map(prev)
            next.delete(key)
            return next
          })
          const result = yield* runRefresh(target).pipe(Effect.ensuring(drop))
          yield* Deferred.succeed(deferred, result)
          return result
        })

      const snapshots = (): Effect.Effect<Banyan.ProviderUsageSnapshot[], never, never> =>
        Effect.gen(function* () {
          const targets = yield* discover()
          const now = yield* Clock.currentTimeMillis
          const entries = yield* Ref.get(cache)
          const fresh: Banyan.ProviderUsageSnapshot[] = []
          const missing: Target[] = []
          const staleTargets: Target[] = []
          for (const target of targets) {
            const entry = entries.get(cacheKeyFor(target))
            if (entry && Banyan.isFresh(entry.snapshot.fetchedAt, now, entry.ttlMs)) {
              fresh.push(entry.snapshot)
            } else if (entry) {
              fresh.push(entry.snapshot)
              staleTargets.push(target)
            } else {
              missing.push(target)
            }
          }
          if (staleTargets.length > 0) {
            yield* Effect.forEach(staleTargets, refreshOne, {
              concurrency: Banyan.PROVIDER_USAGE_MAX_CONCURRENCY,
              discard: true,
            }).pipe(Effect.forkIn(scope), Effect.asVoid)
          }
          const refreshed = yield* Effect.forEach(missing, refreshOne, {
            concurrency: Banyan.PROVIDER_USAGE_MAX_CONCURRENCY,
          })
          return sortSnapshots([...fresh, ...refreshed])
        })

      const refresh = (
        providerID?: string,
      ): Effect.Effect<Banyan.ProviderUsageSnapshot[], never, never> =>
        Effect.gen(function* () {
          const targets = yield* discover()
          const filtered =
            providerID === undefined ? targets : targets.filter((item) => matchesProviderID(item.providerID, providerID))
          const result = yield* Effect.forEach(filtered, refreshOne, {
            concurrency: Banyan.PROVIDER_USAGE_MAX_CONCURRENCY,
          })
          return sortSnapshots(result)
        })

      return { snapshots, refresh } satisfies Interface
    }),
  )

export const layer: Layer.Layer<Service, never, Auth.Service | Provider.Service> = layerWithOptions()
