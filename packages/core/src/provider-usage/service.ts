export * as ProviderUsage from "./service.js"

import { Cause, Clock, Context, Deferred, Effect, Layer, Option, Ref } from "effect"
import type { Credential } from "@opencode/schema/credential"
import type { Provider as ProviderSchema } from "@opencode/schema/provider"
import { Provider } from "../provider.js"
import { Integration } from "../integration.js"
import { IntegrationConnection } from "../integration/connection.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { ProviderUsageError } from "./error.js"
import {
  canonicalDisplayName,
  canonicalProviderID,
  DEFAULT_TTL_MS,
  errorSnapshot,
  isFresh,
  isOpenCodeAlias,
  markStale,
  matchesProviderID,
  MAX_CONCURRENCY,
  redactSecrets,
  sortSnapshots,
  unauthenticatedSnapshot,
  unsupportedSnapshot,
  type List,
  type Snapshot,
} from "./schema.js"
import { BUILT_IN_ADAPTERS } from "./adapters/index.js"
import { DEFAULT_ENDPOINTS, type Adapter, type Endpoints, type FetchImpl } from "./adapters/types.js"

/**
 * Provider quota collection.
 *
 * The service lives in core, resolves the credential through
 * `Integration.connection.resolve`, performs the provider's fixed usage request
 * itself, and returns only normalized numbers. This seam adds no way to read a
 * credential: its plugin-facing surface is one result-only method
 * (`ctx.provider.usage`) that accepts a provider filter and a cache flag, never a
 * URL, header, or auth parameter.
 *
 * Port of v1 `packages/opencode/src/provider/usage.ts` with the v1 payload
 * shape kept intact: `{ snapshots: [...] }`, TTL caching, per-account cache
 * identity, in-flight dedupe, rate-limit backoff, and stale-on-failure.
 */

export interface Interface {
  /** Cached snapshots; `force` bypasses the TTL and `providerID` filters. */
  readonly snapshots: (input?: { readonly force?: boolean; readonly providerID?: string }) => Effect.Effect<List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderUsage") {}

/** One provider the panel represents, with a lazy, core-only credential read. */
export interface Target {
  readonly providerID: string
  readonly displayName: string
  readonly hasAuth: boolean
  readonly authType?: string
  /** Connection identity; never derived from or equal to a secret. */
  readonly accountKey: string
  readonly settings?: ProviderSchema.Settings
  readonly credential: () => Effect.Effect<Credential.Value | undefined>
}

export interface Options {
  /** Test seam: every adapter request goes through this implementation. */
  readonly fetchImpl?: FetchImpl
  /** Test seam: point adapters at a local fake server (fixed paths). */
  readonly endpoints?: Endpoints
  readonly defaultTtlMs?: number
  /** Test seam: replace provider discovery + credential resolution. */
  readonly targets?: () => Effect.Effect<ReadonlyArray<Target>>
  /** Test seam: replace the built-in adapter list. */
  readonly adapters?: ReadonlyArray<Adapter>
}

interface CacheEntry {
  readonly snapshot: Snapshot
  readonly ttlMs: number
}

const defaultFetch: FetchImpl = (input, init) => fetch(input, init)

const cacheKeyFor = (target: Target): string => `${target.providerID} ${target.accountKey}`

const authTypeFor = (connection: IntegrationConnection.Info): string | undefined => {
  if (connection.type === "env") return "api"
  if (connection.method === "key") return "api"
  if (connection.method === "oauth") return "oauth"
  return undefined
}

const accountKeyFor = (connection: IntegrationConnection.Info | undefined): string => {
  if (!connection) return "none"
  return connection.type === "env" ? `env:${connection.name}` : `credential:${connection.id}`
}

export const make = (options: Options = {}): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const fetchImpl = options.fetchImpl ?? defaultFetch
    const endpoints = options.endpoints ?? DEFAULT_ENDPOINTS
    const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS
    const adapters = options.adapters ?? BUILT_IN_ADAPTERS
    const cache = yield* Ref.make(new Map<string, CacheEntry>())
    const backoffUntil = yield* Ref.make(new Map<string, number>())
    const inflight = yield* Ref.make(new Map<string, Deferred.Deferred<Snapshot>>())

    const adapterFor = (target: Target): Adapter | undefined =>
      adapters.find((adapter) =>
        adapter.supports({
          providerID: target.providerID,
          hasAuth: target.hasAuth,
          ...(target.authType === undefined ? {} : { authType: target.authType }),
        }),
      )

    const errorToSnapshot = (target: Target, cause: Cause.Cause<unknown>, now: number) =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(cache)).get(cacheKeyFor(target))?.snapshot
        const failure = Cause.findErrorOption(cause)
        const error =
          Option.isSome(failure) && failure.value instanceof ProviderUsageError
            ? failure.value
            : undefined
        if (!error) {
          // Never surface a raw cause: a fetch implementation or an unexpected
          // defect can embed the request (and therefore the token) in its
          // message. Redaction runs before anything is cached or returned.
          const message = redactSecrets(Cause.pretty(cause))
          if (cached) return markStale(cached)
          return errorSnapshot(
            target.providerID,
            target.displayName,
            message.length > 0 ? message : "Usage request failed",
            now,
          )
        }
        switch (error.reason) {
          case "unauthenticated":
            return unauthenticatedSnapshot(target.providerID, target.displayName, now)
          case "unsupported":
            return unsupportedSnapshot(
              target.providerID,
              target.displayName,
              now,
              error.message.length > 0 ? error.message : "Usage unavailable",
            )
          case "rate_limited": {
            const retryAfter = error.retryAfterMs ?? 60_000
            yield* Ref.update(backoffUntil, (prev) => new Map(prev).set(cacheKeyFor(target), now + retryAfter))
            if (cached) return markStale(cached)
            return errorSnapshot(target.providerID, target.displayName, redactSecrets(error.message), now)
          }
          case "network":
          case "upstream":
            if (cached) return markStale(cached)
            return errorSnapshot(target.providerID, target.displayName, redactSecrets(error.message), now)
        }
      })

    const runRefresh = (target: Target) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const key = cacheKeyFor(target)
        const adapter = adapterFor(target)
        if (!adapter) return unsupportedSnapshot(target.providerID, target.displayName, now)
        const ttlMs = adapter.refreshIntervalSeconds * 1000 || defaultTtlMs
        const fetched = yield* adapter
          .fetch({
            providerID: target.providerID,
            displayName: target.displayName,
            credential: target.credential,
            settings: target.settings,
            accountKey: target.accountKey,
            fetch: fetchImpl,
            endpoints,
          })
          .pipe(
            Effect.timeout("15 seconds"),
            Effect.catchCause((cause) => errorToSnapshot(target, cause, now)),
          )
        const cacheable = adapter.cacheable?.(fetched) ?? true
        if (fetched.status === "available") {
          const snapshot = { ...fetched, fetchedAt: now }
          if (cacheable) yield* Ref.update(cache, (prev) => new Map(prev).set(key, { snapshot, ttlMs }))
          yield* Ref.update(backoffUntil, (prev) => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          })
          return snapshot
        }
        if (!cacheable) {
          // The adapter owns state a later event replaces. Drop the previous
          // row too, or the panel keeps showing a value that just expired.
          yield* Ref.update(cache, (prev) => {
            if (!prev.has(key)) return prev
            const next = new Map(prev)
            next.delete(key)
            return next
          })
          return fetched
        }
        const existing = (yield* Ref.get(cache)).get(key)
        if (!existing) yield* Ref.update(cache, (prev) => new Map(prev).set(key, { snapshot: fetched, ttlMs }))
        return fetched
      })

    // Deduplicate concurrent refreshes per provider/account.
    const refreshOne = (target: Target) =>
      Effect.gen(function* () {
        const key = cacheKeyFor(target)
        const now = yield* Clock.currentTimeMillis
        const until = (yield* Ref.get(backoffUntil)).get(key)
        if (until !== undefined && now < until) {
          const cached = (yield* Ref.get(cache)).get(key)?.snapshot
          if (cached) return cached
          return errorSnapshot(target.providerID, target.displayName, "Usage rate limited", now)
        }
        const existing = (yield* Ref.get(inflight)).get(key)
        if (existing) return yield* Deferred.await(existing)
        const deferred = yield* Deferred.make<Snapshot>()
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

    const collect = (input?: { readonly force?: boolean; readonly providerID?: string }) =>
      Effect.gen(function* () {
        const targets = yield* (options.targets?.() ?? Effect.succeed([] as ReadonlyArray<Target>))
        const selected =
          input?.providerID === undefined
            ? targets
            : targets.filter((target) => matchesProviderID(target.providerID, input.providerID!))
        if (input?.force === true) {
          const refreshed = yield* Effect.forEach(selected, refreshOne, { concurrency: MAX_CONCURRENCY })
          return sortSnapshots(refreshed)
        }
        const at = yield* Clock.currentTimeMillis
        const cached = yield* Ref.get(cache)
        const fresh: Snapshot[] = []
        const stale: Target[] = []
        const missing: Target[] = []
        for (const target of selected) {
          const entry = cached.get(cacheKeyFor(target))
          if (entry === undefined) missing.push(target)
          else {
            // A stale row is served immediately and refreshed in the
            // background, matching v1's `snapshots()` behavior.
            fresh.push(entry.snapshot)
            if (!isFresh(entry.snapshot.fetchedAt, at, entry.ttlMs)) stale.push(target)
          }
        }
        if (stale.length > 0)
          yield* Effect.forEach(stale, refreshOne, { concurrency: MAX_CONCURRENCY, discard: true })
        const refreshed = yield* Effect.forEach(missing, refreshOne, { concurrency: MAX_CONCURRENCY })
        return sortSnapshots([...fresh, ...refreshed])
      })

    return {
      snapshots: (input) =>
        collect(input).pipe(
          Effect.map((snapshots) => ({ snapshots })),
          // A provider-list or resolver failure degrades to an empty list,
          // never a throw: the panel stays useful and no error text (which
          // could mention a credential) crosses back.
          Effect.catchCause(() => Effect.succeed({ snapshots: [] })),
        ),
    }
  })

/**
 * Resolves provider + integration connection into usage targets without
 * resolving secrets. The credential thunk runs only when an adapter actually
 * fetches, so `Integration.connection.resolve` (which may refresh an OAuth
 * token) is bounded to providers whose panel row makes a request.
 */
const discover = (
  providers: ReadonlyArray<ProviderSchema.Info>,
  active: (integrationID: Integration.ID) => Effect.Effect<IntegrationConnection.Info | undefined>,
  resolve: (connection: IntegrationConnection.Info) => Effect.Effect<Credential.Value | undefined>,
): Effect.Effect<ReadonlyArray<Target>> =>
  Effect.forEach(
    providers,
    (provider) =>
      Effect.gen(function* () {
        const integrationID = provider.integrationID ?? Integration.ID.make(provider.id)
        const connection =
          (yield* active(integrationID)) ??
          // `opencode` and `opencode-go` are one provider on one Console
          // account; a catalog-only alias may have no integrationID of its
          // own, so reuse the Console connection (v1's alias fallback).
          (isOpenCodeAlias(provider.id) ? yield* active(Integration.ID.make("opencode")) : undefined)
        return { provider, connection }
      }),
    { concurrency: MAX_CONCURRENCY },
  ).pipe(
    Effect.map((resolved) => {
      const groups = new Map<string, Array<(typeof resolved)[number]>>()
      for (const entry of resolved) {
        const canonical = canonicalProviderID(entry.provider.id)
        const group = groups.get(canonical) ?? []
        group.push(entry)
        groups.set(canonical, group)
      }
      return Array.from(groups, ([canonical, members]) => {
        // `opencode` and `opencode-go` are one panel row in v1. Prefer the
        // canonical provider id, then any member that actually has a
        // connection (env or stored), regardless of catalog order.
        const ordered = [
          ...members.filter((entry) => entry.provider.id === canonical),
          ...members.filter((entry) => entry.provider.id !== canonical),
        ]
        const primary = ordered[0]!
        const connection = ordered.find((entry) => entry.connection !== undefined)?.connection
        const authType = connection === undefined ? undefined : authTypeFor(connection)
        return {
          providerID: canonical,
          displayName: canonicalDisplayName(canonical, primary.provider.name, authType),
          hasAuth: connection !== undefined,
          ...(authType === undefined ? {} : { authType }),
          accountKey: accountKeyFor(connection),
          ...(primary.provider.settings === undefined ? {} : { settings: primary.provider.settings }),
          credential: () => (connection === undefined ? Effect.succeed(undefined) : resolve(connection)),
        } satisfies Target
      })
    }),
  )

export const layerWithOptions = (
  options: Options = {},
): Layer.Layer<Service, never, Provider.Service | Integration.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const integrations = yield* Integration.Service
      const targets =
        options.targets ??
        (() =>
          providers.available().pipe(
            Effect.flatMap((available) =>
              discover(
                available,
                (integrationID) => integrations.connection.active(integrationID),
                (connection) => integrations.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined)),
              ),
            ),
            Effect.orElseSucceed(() => [] as ReadonlyArray<Target>),
          ))
      return yield* make({ ...options, targets })
    }),
  )

export const layer: Layer.Layer<Service, never, Provider.Service | Integration.Service> = layerWithOptions()

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Provider.node, Integration.node],
})
