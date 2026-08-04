import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Session } from "@/session/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { AuthPaths } from "../../src/server/routes/instance/httpapi/groups/auth"
import { Auth } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
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

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, Session.defaultLayer, httpApiServerLayer))

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
        const auth = yield* Auth.Service

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
})
