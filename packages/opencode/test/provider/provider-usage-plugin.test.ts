import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ProviderUsage } from "@/provider/usage"
import type { FetchImpl } from "@/provider/usage"
import {
  pluginManagedAdapterIDs,
  removePluginUsageAdapters,
  syncPluginUsageAdapters,
} from "@/provider/usage/plugin-adapters"
import {
  FIXTURE_ADAPTER_ID,
  FIXTURE_PROVIDER_ID,
  fixtureDuplicateAdapter,
  fixtureMalformedAdapter,
  fixtureThrowingAdapter,
  fixtureUsageAdapter,
  fixtureUsagePlugin,
} from "../fixture/provider-usage-plugin"
import { testEffect } from "../lib/effect"

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })

const stubFetch = (handler: (url: string, init?: RequestInit) => Response): FetchImpl => (input, init) =>
  Promise.resolve(handler(String(input), init))

const providerInfo = (id: string, name: string): Provider.Info => ({
  id: ProviderV2.ID.make(id),
  name,
  source: "api",
  env: [],
  options: {},
  models: {},
})

const authApi = (key: string): Auth.Info => new Auth.Api({ type: "api", key })

describe("plugin-provided provider usage adapters", () => {
  beforeEach(() => {
    ProviderUsage.resetUsageAdapters()
    removePluginUsageAdapters([...pluginManagedAdapterIDs()])
  })

  const serviceLayer = (auths: Record<string, Auth.Info>, providers: Record<string, Provider.Info>) =>
    ProviderUsage.layerWithOptions({ fetchImpl: stubFetch(() => jsonResponse({})) }).pipe(
      Layer.provide(
        Layer.mock(Auth.Service, {
          all: () => Effect.succeed(auths),
        }),
      ),
      Layer.provide(
        Layer.mock(Provider.Service, {
          list: () => Effect.succeed(providers),
        }),
      ),
    )

  const it = testEffect(Layer.empty as Layer.Layer<never>)

  test("fixture plugin registers without a central switch and returns a normalized snapshot", async () => {
    const sync = syncPluginUsageAdapters([fixtureUsagePlugin()])
    expect(sync.registered).toContain(FIXTURE_ADAPTER_ID)
    expect(sync.skipped).toHaveLength(0)
    expect(ProviderUsage.listAdapters().map((a) => a.id)).toContain(FIXTURE_ADAPTER_ID)
    const layer = serviceLayer(
      { [FIXTURE_PROVIDER_ID]: authApi("fixture-key-123") },
      { [FIXTURE_PROVIDER_ID]: providerInfo(FIXTURE_PROVIDER_ID, "Fixture") },
    )
    const snapshots = await Effect.runPromise(
      ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh(FIXTURE_PROVIDER_ID)),
        Effect.provide(layer),
      ),
    )
    expect(snapshots).toHaveLength(1)
    const snapshot = snapshots[0]
    expect(snapshot.providerID).toBe(FIXTURE_PROVIDER_ID)
    expect(snapshot.displayName).toBe("Fixture")
    expect(snapshot.status).toBe("available")
    expect(snapshot.confidence).toBe("exact")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0].remainingPercent).toBe(42)
    expect(snapshot.windows[0].label).toBe("Monthly")
    expect(JSON.stringify(snapshots)).not.toContain("fixture-key-123")
  })

  test("plugin context carries sanitized metadata plus in-process auth and fetch", async () => {
    let seen: Record<string, unknown> = {}
    const sync = syncPluginUsageAdapters([
      fixtureUsagePlugin(
        fixtureUsageAdapter({
          fetch: async (ctx) => {
            seen = { ...ctx, auth: ctx.auth, fetch: typeof ctx.fetch }
            return {
              providerID: ctx.providerID,
              displayName: ctx.displayName,
              status: "available",
              confidence: "exact",
              windows: [],
              fetchedAt: Date.now(),
            }
          },
        }),
      ),
    ])
    expect(sync.registered).toContain(FIXTURE_ADAPTER_ID)
    const layer = serviceLayer(
      { [FIXTURE_PROVIDER_ID]: authApi("ctx-key") },
      { [FIXTURE_PROVIDER_ID]: providerInfo(FIXTURE_PROVIDER_ID, "Fixture") },
    )
    await Effect.runPromise(
      ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh(FIXTURE_PROVIDER_ID)),
        Effect.provide(layer),
      ),
    )
    expect(seen["providerID"]).toBe(FIXTURE_PROVIDER_ID)
    expect(seen["displayName"]).toBe("Fixture")
    expect(seen["hasAuth"]).toBe(true)
    expect(seen["authType"]).toBe("api")
    expect(seen["fetch"]).toBe("function")
    // In-process auth context is available (same trust as provider.models),
    // but credentials never reach the snapshot.
    expect(seen["auth"]).toMatchObject({ type: "api" })
  })

  it.effect("duplicate adapter ids are deterministic: later hook wins, single entry", () =>
    Effect.gen(function* () {
      const sync = syncPluginUsageAdapters([
        fixtureUsagePlugin(),
        fixtureUsagePlugin(fixtureDuplicateAdapter()),
      ])
      expect(sync.registered).toContain(FIXTURE_ADAPTER_ID)
      expect(ProviderUsage.listAdapters().filter((a) => a.id === FIXTURE_ADAPTER_ID)).toHaveLength(1)
      const layer = serviceLayer(
        {},
        { [FIXTURE_PROVIDER_ID]: providerInfo(FIXTURE_PROVIDER_ID, "Fixture") },
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh(FIXTURE_PROVIDER_ID)),
        Effect.provide(layer),
      )
      expect(snapshots[0].windows[0].remainingPercent).toBe(7)
    }),
  )

  it.effect("malformed payloads and plugin throws become isolated errors", () =>
    Effect.gen(function* () {
      const sync = syncPluginUsageAdapters([
        fixtureUsagePlugin(),
        fixtureUsagePlugin(fixtureMalformedAdapter()),
        fixtureUsagePlugin(fixtureThrowingAdapter()),
      ])
      expect(sync.skipped).toHaveLength(0)
      const layer = serviceLayer(
        { [FIXTURE_PROVIDER_ID]: authApi("good-key") },
        {
          [FIXTURE_PROVIDER_ID]: providerInfo(FIXTURE_PROVIDER_ID, "Fixture"),
          ["fixture-malformed-provider"]: providerInfo("fixture-malformed-provider", "Malformed"),
          ["fixture-throwing-provider"]: providerInfo("fixture-throwing-provider", "Throwing"),
        },
      )
      const snapshots = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh()),
        Effect.provide(layer),
      )
      const byId = Object.fromEntries(snapshots.map((s) => [s.providerID, s]))
      // The healthy fixture provider is unaffected by its failing neighbours.
      expect(byId[FIXTURE_PROVIDER_ID].status).toBe("available")
      expect(byId["fixture-malformed-provider"].status).toBe("error")
      expect(byId["fixture-malformed-provider"].message).toContain("malformed")
      expect(byId["fixture-throwing-provider"].status).toBe("error")
      const encoded = JSON.stringify(snapshots)
      expect(encoded).not.toContain("sk-secret-xyz")
      expect(encoded).not.toContain("good-key")
    }),
  )

  it.effect("shape violations skip registration without throwing", () =>
    Effect.gen(function* () {
      const sync = syncPluginUsageAdapters([
        { provider: { id: "bad", usage: { id: "", providerID: "", fetch: "nope" } as never } },
        fixtureUsagePlugin(),
      ])
      expect(sync.registered).toContain(FIXTURE_ADAPTER_ID)
      expect(sync.skipped).toHaveLength(1)
      expect(ProviderUsage.listAdapters().map((a) => a.id)).toContain(FIXTURE_ADAPTER_ID)
    }),
  )

  it.effect("unload/removal prunes managed ids and leaves no stale registration", () =>
    Effect.gen(function* () {
      syncPluginUsageAdapters([fixtureUsagePlugin()])
      expect(pluginManagedAdapterIDs()).toContain(FIXTURE_ADAPTER_ID)
      const before = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh(FIXTURE_PROVIDER_ID)),
        Effect.provide(
          serviceLayer({}, { [FIXTURE_PROVIDER_ID]: providerInfo(FIXTURE_PROVIDER_ID, "Fixture") }),
        ),
      )
      expect(before[0].status).toBe("available")
      // Simulate plugin unload: sync with a hook set that no longer supplies it.
      const resync = syncPluginUsageAdapters([])
      expect(resync.registered).toHaveLength(0)
      expect(pluginManagedAdapterIDs()).not.toContain(FIXTURE_ADAPTER_ID)
      expect(ProviderUsage.listAdapters().map((a) => a.id)).not.toContain(FIXTURE_ADAPTER_ID)
      const after = yield* ProviderUsage.Service.pipe(
        Effect.flatMap((service) => service.refresh(FIXTURE_PROVIDER_ID)),
        Effect.provide(
          serviceLayer({}, { [FIXTURE_PROVIDER_ID]: providerInfo(FIXTURE_PROVIDER_ID, "Fixture") }),
        ),
      )
      expect(after[0].status).toBe("unsupported")
    }),
  )
})
