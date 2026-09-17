import type { Hooks, ProviderUsagePluginAdapter } from "@opencode-ai/plugin"

/**
 * Fixture plugin proving a custom provider can add quota support without
 * editing the central registry. Mirrors exactly what an external npm/file
 * plugin author writes: a `provider` hook returning model and usage hooks.
 */

export const FIXTURE_PROVIDER_ID = "fixture-provider"
export const FIXTURE_ADAPTER_ID = "banyan-usage-fixture"

export const fixtureUsagePayload = (remainingPercent = 42) => ({
  providerID: FIXTURE_PROVIDER_ID,
  displayName: "Fixture",
  status: "available",
  confidence: "exact",
  windows: [
    {
      id: "monthly",
      label: "Monthly",
      kind: "quota",
      remainingPercent,
      durationSeconds: 2_592_000,
    },
  ],
  fetchedAt: Date.now(),
})

/** Well-behaved fixture adapter: returns a normalized snapshot. */
export const fixtureUsageAdapter = (
  overrides: Partial<ProviderUsagePluginAdapter> = {},
): ProviderUsagePluginAdapter => ({
  id: FIXTURE_ADAPTER_ID,
  providerID: FIXTURE_PROVIDER_ID,
  refreshIntervalSeconds: 60,
  fetch: async (ctx) => ({ ...fixtureUsagePayload(42), providerID: ctx.providerID, displayName: ctx.displayName }),
  ...overrides,
})

/** Same id, different payload — later registration must win deterministically. */
export const fixtureDuplicateAdapter = (): ProviderUsagePluginAdapter =>
  fixtureUsageAdapter({
    fetch: async (ctx) => ({ ...fixtureUsagePayload(7), providerID: ctx.providerID, displayName: ctx.displayName }),
  })

/** Returns a shape that fails `ProviderUsageSnapshot` validation. */
export const fixtureMalformedAdapter = (): ProviderUsagePluginAdapter =>
  fixtureUsageAdapter({
    id: "banyan-usage-fixture-malformed",
    providerID: "fixture-malformed-provider",
    fetch: async () => ({ nope: true }),
  })

/** Rejects with a secret-bearing error to prove redaction + isolation. */
export const fixtureThrowingAdapter = (): ProviderUsagePluginAdapter =>
  fixtureUsageAdapter({
    id: "banyan-usage-fixture-throwing",
    providerID: "fixture-throwing-provider",
    fetch: async () => {
      throw new Error("upstream exploded Bearer sk-secret-xyz")
    },
  })

export const fixtureUsagePlugin = (adapter: ProviderUsagePluginAdapter = fixtureUsageAdapter()): Hooks => ({
  provider: {
    id: adapter.providerID,
    usage: adapter,
  },
})
