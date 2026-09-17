import type { Auth } from "@opencode-ai/sdk/v2"

/**
 * Public plugin hook for provider usage (quota) adapters.
 *
 * A custom provider adds quota support by returning one of these from its
 * `provider.usage` hook — no central registry edit required:
 *
 * ```ts
 * export default async () => ({
 *   provider: {
 *     id: "my-provider",
 *     models: async () => ({ ... }),
 *     usage: {
 *       id: "banyan-usage-my-provider",
 *       providerID: "my-provider",
 *       refreshIntervalSeconds: 60,
 *       fetch: async (ctx) => ({
 *         providerID: ctx.providerID,
 *         displayName: ctx.displayName,
 *         status: "available",
 *         confidence: "exact",
 *         windows: [{ id: "monthly", label: "Monthly", kind: "quota", remainingPercent: 42 }],
 *         fetchedAt: Date.now(),
 *       }),
 *     },
 *   },
 * })
 * ```
 *
 * Security contract (enforced by the opencode glue, not by trust):
 *
 * - Adapters are process-local only. Executable adapter code is never
 *   accepted over HTTP or configuration JSON — the hook function runs
 *   in-process with the same trust as the `provider.models` hook.
 * - `auth` is passed in-process only and is never serialized to logs,
 *   cache, or HTTP. Prefer the provided `fetch` capability over reading
 *   credentials out of `auth` yourself.
 * - Results are validated against the `Banyan/ProviderUsageSnapshot`
 *   schema; malformed payloads become isolated `upstream` errors and never
 *   reach the cache or HTTP responses.
 * - `message` strings are secret-redacted before caching. Never embed
 *   tokens, headers, or raw upstream bodies in returned snapshots.
 * - `supports` is synchronous by design: discovery scans every adapter per
 *   provider, so async gating would serialize refreshes. Omit it to match
 *   exactly `providerID`.
 */
export interface ProviderUsageSupportsInput {
  readonly providerID: string
  readonly hasAuth: boolean
  readonly authType?: string
}

export interface ProviderUsagePluginContext {
  readonly providerID: string
  readonly displayName: string
  readonly hasAuth: boolean
  readonly authType?: string
  readonly options: Record<string, unknown>
  readonly accountKey: string
  /**
   * In-process auth context (same trust as the `provider.models` hook).
   * Never log or serialize this value.
   */
  readonly auth?: Auth
  /**
   * The service fetch implementation (stubbed in tests). Use this for
   * upstream requests so credential headers stay inside your adapter.
   */
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
}

export interface ProviderUsagePluginAdapter {
  /** Unique adapter id. Duplicates are deterministic: last registration wins. */
  readonly id: string
  readonly providerID: string
  /** Cache TTL hint in seconds. Defaults to 60 when missing or invalid. */
  readonly refreshIntervalSeconds?: number
  readonly supports?: (input: ProviderUsageSupportsInput) => boolean
  /** Return a `ProviderUsageSnapshot`-shaped value; it is schema-validated. */
  readonly fetch: (ctx: ProviderUsagePluginContext) => Promise<unknown>
}
