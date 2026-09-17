/**
 * Plugin-provided provider usage adapters (provider-usage sidebar, Phase 6).
 *
 * Hook choice: external npm/file plugins can only implement V1 `Hooks`
 * (`PluginLoader` loads them, `Plugin.list()` exposes them, and
 * `provider.ts` already consumes `hook.provider.models` the same way). V2
 * hooks (`packages/core/src/plugin.ts` `HookSpec`) are Effect-internal with
 * no npm/file loader path, so external plugins cannot implement them.
 * Extending `provider.usage` is therefore the smallest public in-process
 * hook — no `PluginInput` capability, no loader change, no new trigger.
 *
 * An explicit `Effect` registration API was rejected for the same reason:
 * V1 plugins are plain async functions without an Effect runtime, so the
 * hook carries plain `Promise` fetch functions and this module wraps them
 * into internal `Adapter`s. Plugin code never crosses JSON/HTTP — the
 * registry (`customAdapters` in `../usage`) stays process-local.
 *
 * Guarantees enforced here, never by trust:
 *
 * - Duplicate ids are deterministic: hooks are visited in load order and
 *   later registrations replace earlier ones (same as
 *   `registerUsageAdapter`).
 * - Plugin failure is isolated: a throwing `supports`, a rejecting `fetch`,
 *   or a malformed payload degrades to `false` / typed `upstream` errors
 *   for that provider only.
 * - Results are validated against `Banyan/ProviderUsageSnapshot` and the
 *   identity fields are forced to the requesting target so a plugin cannot
 *   spoof another provider's row. Messages are secret-redacted before they
 *   can reach the cache or HTTP.
 * - `syncPluginUsageAdapters` reconciles: ids it manages but no longer sees
 *   are unregistered, so unload/removal leaves no stale registration.
 */

import { Effect, Schema } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { Hooks, ProviderUsagePluginAdapter, ProviderUsagePluginContext } from "@opencode-ai/plugin"
import { registerUsageAdapter, unregisterUsageAdapter } from "../usage"
import type { Adapter, AdapterContext } from "../usage"

const DEFAULT_REFRESH_INTERVAL_SECONDS = 60
const MAX_PLUGIN_MESSAGE_CHARS = 200

const shortMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  const sliced = raw.slice(0, MAX_PLUGIN_MESSAGE_CHARS)
  return sliced.length > 0 ? sliced : "Plugin usage adapter failed"
}

const toInternal = (plugin: ProviderUsagePluginAdapter): Adapter => ({
  id: plugin.id,
  providerID: plugin.providerID,
  refreshIntervalSeconds:
    typeof plugin.refreshIntervalSeconds === "number" &&
    Number.isFinite(plugin.refreshIntervalSeconds) &&
    plugin.refreshIntervalSeconds > 0
      ? plugin.refreshIntervalSeconds
      : DEFAULT_REFRESH_INTERVAL_SECONDS,
  supports: (input) => {
    if (!plugin.supports) return input.providerID === plugin.providerID
    try {
      return plugin.supports(input)
    } catch {
      return false
    }
  },
  fetch: (ctx: AdapterContext) =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: () =>
          plugin.fetch({
            providerID: ctx.providerID,
            displayName: ctx.displayName,
            hasAuth: ctx.auth !== undefined,
            authType: ctx.auth?.type,
            options: ctx.options,
            accountKey: ctx.accountKey,
            // In-process passthrough only — never logged or serialized.
            // Same trust as the `provider.models` hook (provider.ts),
            // which receives the internal auth entry directly.
            auth: ctx.auth as unknown as ProviderUsagePluginContext["auth"],
            fetch: ctx.fetch,
          }),
        catch: (error) =>
          new Banyan.ProviderUsageError({
            providerID: ctx.providerID,
            reason: "upstream",
            message: Banyan.redactSecrets(shortMessage(error)),
          }),
      })
      const decoded = yield* Schema.decodeUnknownEffect(Banyan.ProviderUsageSnapshot)(raw).pipe(
        Effect.mapError(
          () =>
            new Banyan.ProviderUsageError({
              providerID: ctx.providerID,
              reason: "upstream",
              message: `Plugin usage adapter "${plugin.id}" returned a malformed snapshot`,
            }),
        ),
      )
      return new Banyan.ProviderUsageSnapshot({
        ...decoded,
        providerID: ctx.providerID,
        displayName: ctx.displayName,
        ...(decoded.message !== undefined ? { message: Banyan.redactSecrets(decoded.message) } : {}),
      })
    }),
})

export interface PluginUsageSyncResult {
  readonly registered: string[]
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>
}

/** Adapter ids currently managed by `syncPluginUsageAdapters`. */
const managedIDs = new Set<string>()

export const pluginManagedAdapterIDs = (): ReadonlyArray<string> => [...managedIDs]

const isUsableAdapter = (value: unknown): value is ProviderUsagePluginAdapter => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate["id"] === "string" &&
    candidate["id"].length > 0 &&
    typeof candidate["providerID"] === "string" &&
    candidate["providerID"].length > 0 &&
    typeof candidate["fetch"] === "function"
  )
}

const describeID = (value: unknown): string => {
  if (typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["id"] === "string") {
    return (value as Record<string, string>)["id"]
  }
  return "<unknown>"
}

/**
 * Register usage adapters from loaded plugin hooks. Total: never throws —
 * per-adapter problems are reported in `skipped`. Prunes managed ids that
 * are no longer supplied so removal leaves no stale registration.
 */
export const syncPluginUsageAdapters = (hooks: ReadonlyArray<Hooks>): PluginUsageSyncResult => {
  const registered: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  const desired = new Map<string, ProviderUsagePluginAdapter>()
  for (const hook of hooks) {
    let usage: unknown
    try {
      usage = hook.provider?.usage
    } catch (error) {
      skipped.push({ id: "<unknown>", reason: `provider hook unreadable: ${shortMessage(error)}` })
      continue
    }
    if (usage === undefined) continue
    const list = Array.isArray(usage) ? usage : [usage]
    for (const item of list) {
      if (!isUsableAdapter(item)) {
        skipped.push({
          id: describeID(item),
          reason: "usage adapter must define a non-empty id/providerID and a fetch function",
        })
        continue
      }
      desired.set(item.id, item)
    }
  }
  for (const id of [...managedIDs]) {
    if (!desired.has(id)) {
      unregisterUsageAdapter(id)
      managedIDs.delete(id)
    }
  }
  for (const [id, plugin] of desired) {
    try {
      registerUsageAdapter(toInternal(plugin))
      managedIDs.add(id)
      registered.push(id)
    } catch (error) {
      skipped.push({ id, reason: shortMessage(error) })
    }
  }
  return { registered, skipped }
}

/** Explicit removal for plugin dispose paths; also prunes managed tracking. */
export const removePluginUsageAdapters = (ids: ReadonlyArray<string>): void => {
  for (const id of ids) {
    unregisterUsageAdapter(id)
    managedIDs.delete(id)
  }
}
