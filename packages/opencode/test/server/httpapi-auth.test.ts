import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { Config, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import os from "os"
import path from "path"
import fs from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "@opencode-ai/core/auth"
import { Catalog } from "@opencode-ai/core/catalog"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { AccountPlugin } from "@opencode-ai/core/plugin/account"
import { Project } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@/session/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { AuthPaths } from "../../src/server/routes/instance/httpapi/groups/auth"
import { Auth as AuthV1 } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { requestInDirectory } from "./httpapi-layer"
import { disposeMiddleware } from "../../src/server/routes/instance/httpapi/lifecycle"

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    middleware: disposeMiddleware,
    disableListenLog: true,
    disableLogger: true,
  },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

// V2 account store (account.json) isolated to a per-process tmp dir so the
// tests never touch the real account.json.
const testDataDir = path.join(os.tmpdir(), `opencode-httpapi-auth-${process.pid}`)
const accountV2Layer = Auth.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provideMerge(EventV2.defaultLayer),
  Layer.provide(
    Global.layerWith({
      data: testDataDir,
      cache: path.join(testDataDir, "cache"),
      config: path.join(testDataDir, "config"),
      state: path.join(testDataDir, "state"),
      tmp: path.join(testDataDir, "tmp"),
      bin: path.join(testDataDir, "bin"),
      log: path.join(testDataDir, "log"),
      repos: path.join(testDataDir, "repos"),
    }),
  ),
)
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make("test"),
    workspaceID: undefined,
    project: { id: Project.ID.global, directory: AbsolutePath.make("test") },
  }),
)

const it = testEffect(
  Layer.mergeAll(
    AuthV1.defaultLayer,
    Session.defaultLayer,
    httpApiServerLayer,
    Catalog.locationLayer.pipe(
      Layer.provideMerge(EventV2.defaultLayer),
      Layer.provideMerge(locationLayer),
    ),
    accountV2Layer,
  ),
)

const authFile = () => path.join(Global.Path.data, "auth.json")

// Regression: auth.set / auth.remove used to live on ControlApi (RootHttpApi),
// which never binds InstanceContextMiddleware. `markInstanceForDisposal` read
// InstanceState.context, died with "InstanceRef not provided", and every
// request returned an opaque 500 (UnknownError). They now live on
// InstanceHttpApi, which provides WorkspaceRoutingMiddleware +
// InstanceContextMiddleware, so the credential is persisted, the instance is
// disposed, and the TUI refreshes its provider list.
describe("auth HttpApi (instance-scoped)", () => {
  let authBackup: string | null = null
  let disposedDirectories: string[] = []

  const onGlobalEvent = (event: { directory?: string; payload?: { type?: string } }) => {
    if (event.payload?.type === "server.instance.disposed") disposedDirectories.push(event.directory ?? "")
  }

  beforeAll(async () => {
    const file = authFile()
    authBackup = (await Bun.file(file).exists()) ? await Bun.file(file).text() : null
    GlobalBus.on("event", onGlobalEvent)
    await fs.mkdir(testDataDir, { recursive: true })
  })

  afterEach(async () => {
    await disposeAllInstances()
    // Restore the real auth.json byte-for-byte — never leave test keys behind.
    const file = authFile()
    if (authBackup === null) await Bun.write(file, "{}").catch(() => {})
    else await Bun.write(file, authBackup)
    disposedDirectories = []
  })

  afterAll(() => {
    GlobalBus.off("event", onGlobalEvent)
  })

  const providerID = "auth-http-test-provider"
  const authURL = () => AuthPaths.auth.replace(":providerID", providerID)

  it.instance(
    "auth.set and auth.remove return 200, persist/remove the credential, and dispose the instance",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const auth = yield* AuthV1.Service

        const put = yield* requestInDirectory(authURL(), test.directory, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "api", key: "sk-test-key" }),
        })
        expect(put.status).toBe(200)
        expect(yield* put.json).toBe(true)
        const stored = yield* auth.get(providerID)
        expect(stored).toBeDefined()
        expect(stored?.type).toBe("api")

        const del = yield* requestInDirectory(authURL(), test.directory, {
          method: "DELETE",
        })
        expect(del.status).toBe(200)
        expect(yield* del.json).toBe(true)
        expect(yield* auth.get(providerID)).toBeUndefined()

        // The disposal must have run (disposeMiddleware executes before the
        // response resolves), which is what triggers the TUI's
        // `server.instance.disposed` → sync re-bootstrap → provider refresh.
        expect(disposedDirectories).toContain(test.directory)
      }),
    { git: false },
    30000,
  )

  it.instance(
    "auth changes propagate to the provider list after disposal (user-visible remove flow)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const catalogProvider = "openai"

        // Set a credential for a real catalog provider.
        const put = yield* requestInDirectory(
          AuthPaths.auth.replace(":providerID", catalogProvider),
          test.directory,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "api", key: "sk-test-key" }),
          },
        )
        expect(put.status).toBe(200)

        // A fresh instance reads the credential → provider shows as connected.
        const listAfterSet = yield* requestInDirectory("/provider", test.directory, { method: "GET" })
        expect(listAfterSet.status).toBe(200)
        const connectedAfterSet = (yield* listAfterSet.json) as { connected: string[] }
        expect(connectedAfterSet.connected).toContain(catalogProvider)

        // Remove it — the DELETE must not 500 and must dispose the instance.
        const del = yield* requestInDirectory(
          AuthPaths.auth.replace(":providerID", catalogProvider),
          test.directory,
          { method: "DELETE" },
        )
        expect(del.status).toBe(200)

        // The next provider list no longer contains it.
        const listAfterRemove = yield* requestInDirectory("/provider", test.directory, { method: "GET" })
        expect(listAfterRemove.status).toBe(200)
        const connectedAfterRemove = (yield* listAfterRemove.json) as { connected: string[] }
        expect(connectedAfterRemove.connected).not.toContain(catalogProvider)
      }),
    { git: false },
    30000,
  )

  it.instance(
    "removing a credential drops the provider from the v2 catalog (model-picker availability)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const catalog = yield* Catalog.Service
        const plugin = yield* PluginV2.Service
        const accounts = yield* Auth.Service
        const events = yield* EventV2.Service
        const providerID = ProviderV2.ID.make("openai")

        // Mirror the production plugin stack: AccountPlugin enables providers
        // backed by an account; the stub creates the openai catalog record.
        yield* plugin.add({
          ...AccountPlugin,
          effect: AccountPlugin.effect.pipe(
            Effect.provideService(Auth.Service, accounts),
            Effect.provideService(EventV2.Service, events),
            Effect.provideService(PluginV2.Service, plugin),
          ),
        })
        yield* plugin.add({
          id: PluginV2.ID.make("test-openai"),
          effect: Effect.succeed({
            "catalog.transform": (evt) => Effect.sync(() => evt.provider.update(providerID, () => {})),
          }),
        })
        yield* Effect.yieldNow

        const catalogHasProvider = (expected: boolean) =>
          Effect.gen(function* () {
            const available = yield* catalog.provider.available()
            const present = available.some((provider) => provider.id === providerID)
            return present === expected ? (true as const) : undefined
          })

        expect(yield* catalog.provider.available()).toEqual([])

        // Setting a V1 credential must also land in the V2 account store so
        // the catalog enables the provider without a restart.
        const put = yield* requestInDirectory(
          AuthPaths.auth.replace(":providerID", "openai"),
          test.directory,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "api", key: "sk-test-key" }),
          },
        )
        expect(put.status).toBe(200)
        yield* pollWithTimeout(catalogHasProvider(true), "provider never became available in the v2 catalog")

        // Removing the credential must drop it from the v2 catalog, which is
        // what removes its models from the model picker.
        const del = yield* requestInDirectory(
          AuthPaths.auth.replace(":providerID", "openai"),
          test.directory,
          { method: "DELETE" },
        )
        expect(del.status).toBe(200)
        yield* pollWithTimeout(catalogHasProvider(false), "provider never dropped from the v2 catalog")
      }),
    { git: false },
    30000,
  )
})
