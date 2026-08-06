import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { memoryHandlers } from "../../src/server/routes/instance/httpapi/handlers/memory"
import { repositoryIntelHandlers } from "../../src/server/routes/instance/httpapi/handlers/repository-intel"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { repositoryIntelServiceMocks } from "../server/repository-intel-mocks"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { HttpRouter } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"
import path from "node:path"

// Same test-only route layer as codegraph-remove-http.test.ts: the request
// context is deliberately an EMPTY context, so InstanceRef is NOT stamped
// (no InstanceContextMiddleware runs for /global/* routes). This reproduces
// the production condition that used to make codegraphBuildHandler die with
// "InstanceRef not provided" and return an opaque empty-body 500.
const buildApiLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const busLayer = Banyan.subagentBusDefaultLayer.pipe(Layer.provide(dbLayer))
  const plansLayer = Banyan.subagentPlansRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const meshLayer = Banyan.meshCoordinatorDefaultLayer.pipe(
    Layer.provide(busLayer),
    Layer.provide(plansLayer),
    Layer.provide(dbLayer),
    Layer.provide(EventV2.defaultLayer),
  )

  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([
        controlHandlers,
        controlPlaneHandlers,
        globalHandlers,
        repositoryIntelHandlers,
        memoryHandlers,
      ]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      Layer.provide(meshLayer),
      Layer.provide(busLayer),
      Layer.provide(plansLayer),
      Layer.provide(dbLayer),
      Layer.provide(repoLayer),
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(
      Layer.mock(Installation.Service)({
        method: () => Effect.succeed("npm"),
        latest: () => Effect.succeed("9.9.9"),
        upgrade: () => Effect.void,
      }),
    ),
    Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
    Layer.provide(repositoryIntelServiceMocks),
  )
}

const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

describe("POST /global/codegraph-build", () => {
  it.live("no root and no instance context returns started:false with a reason (regression: was an opaque 500)", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-build-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)

        const response = yield* HttpClientRequest.post(GlobalPaths.codegraphBuild).pipe(
          HttpClientRequest.bodyJson({}),
          Effect.flatMap(HttpClient.execute),
          Effect.provide(apiLayer),
        )
        expect(response.status).toBe(200)
        const data = (yield* response.json) as {
          started: boolean
          reason?: string
        }
        expect(data.started).toBe(false)
        expect(data.reason).toContain("root")
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("explicit root that does not exist returns started:false with the identity error message", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-build-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)
        const missingRoot = path.join(tmp.path, "does-not-exist")

        const response = yield* HttpClientRequest.post(GlobalPaths.codegraphBuild).pipe(
          HttpClientRequest.bodyJson({ root: missingRoot }),
          Effect.flatMap(HttpClient.execute),
          Effect.provide(apiLayer),
        )
        expect(response.status).toBe(200)
        const data = (yield* response.json) as {
          started: boolean
          reason?: string
        }
        expect(data.started).toBe(false)
        expect(data.reason).toContain("does not exist")
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("explicit existing root returns started:true with canonical dbPath/banyanDir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-build-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)

        const response = yield* HttpClientRequest.post(GlobalPaths.codegraphBuild).pipe(
          HttpClientRequest.bodyJson({ root: tmp.path, force: false }),
          Effect.flatMap(HttpClient.execute),
          Effect.provide(apiLayer),
        )
        expect(response.status).toBe(200)
        const data = (yield* response.json) as {
          started: boolean
          root?: string
          dbPath?: string
          banyanDir?: string
        }
        expect(data.started).toBe(true)
        expect(data.root).toBeTruthy()
        expect(data.dbPath).toContain("banyancode-")
        expect(data.banyanDir).toBeTruthy()
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("filesystem root as explicit root returns started:false refusing to index the drive", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-build-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)
        // On win32 this is the drive root (e.g. `D:\`); on POSIX `/`. Either
        // way it is the filesystem root and must be refused before any
        // kickoff is scheduled.
        const driveRoot = path.parse(process.cwd()).root

        const response = yield* HttpClientRequest.post(GlobalPaths.codegraphBuild).pipe(
          HttpClientRequest.bodyJson({ root: driveRoot }),
          Effect.flatMap(HttpClient.execute),
          Effect.provide(apiLayer),
        )
        expect(response.status).toBe(200)
        const data = (yield* response.json) as {
          started: boolean
          reason?: string
        }
        expect(data.started).toBe(false)
        expect(data.reason).toContain("refusing to index filesystem root")
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )
})
