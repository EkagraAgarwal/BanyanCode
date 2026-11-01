import { expect } from "bun:test"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderUsage } from "@opencode/core/provider-usage/index"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

/** A quota row as the core service returns it: numbers only. */
const snapshot = {
  providerID: "openrouter",
  displayName: "OpenRouter",
  status: "available" as const,
  confidence: "exact" as const,
  windows: [{ id: "credits", label: "Credits", kind: "quota" as const, usedPercent: 10, remainingPercent: 90 }],
  balance: { remaining: 9 },
  fetchedAt: 1_000,
}

const usageStub = ProviderUsage.Service.of({
  snapshots: () => Effect.succeed({ snapshots: [snapshot] }),
})

it.effect("the provider-usage seam gives plugins numbers only, with no way to pass a URL or read a credential", () =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make({ list: () => Effect.succeed([]) }).pipe(
      Effect.provideService(ProviderUsage.Service, usageStub),
    )

    // Credential access from a plugin is activation only: no get/list/read.
    expect(Object.keys(host.credential)).toEqual(["activate"])

    // The usage surface is result-only. There is no method accepting a URL,
    // header, fetch implementation, or credential.
    expect(Object.keys(host.provider).sort()).toEqual(["get", "list", "reload", "transform", "usage"])
    for (const name of ["usage", "list", "get", "reload", "transform"] as const) {
      expect(host.provider[name]).toBeFunction()
    }
    expect(host.provider.usage.length).toBeLessThanOrEqual(1)

    // The result carries normalized numbers, never secret material.
    const result = yield* host.provider.usage({})
    expect(result.snapshots).toEqual([snapshot])
    expect(JSON.stringify(result)).not.toMatch(/token|secret|bearer|authorization|api[_-]?key/i)

    // No path from the provider domain reaches credential material.
    const providerKeys = Object.keys(host.provider).map((key) => key.toLowerCase())
    expect(providerKeys.some((key) => /credential|token|secret|key|auth|resolve/.test(key))).toBe(false)
  }),
)
