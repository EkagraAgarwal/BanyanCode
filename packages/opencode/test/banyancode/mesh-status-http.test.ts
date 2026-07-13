import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
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
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import path from "path"

const buildApiLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
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

const runWithFreshDb = <A, E, R>(body: (dbPath: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.promise(() => tmpdir())
    try {
      const dbPath = path.join(tmp.path, "mesh-status-http.sqlite")
      return yield* body(dbPath)
    } finally {
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }
  })

describe("mesh status HttpApi", () => {
  const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

  it.live("GET /global/mesh/status with valid parentSessionID returns 200 with empty mesh", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const validID = "ses_" + "a".repeat(32)
          const response = yield* Effect.succeed(
            HttpClientRequest.get(`${GlobalPaths.meshStatus}?parentSessionID=${validID}`),
          ).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as {
            parentSessionID: string
            peers: unknown[]
            pendingMessages: number
            recentActivity: unknown[]
          }
          expect(body.parentSessionID).toBe(validID)
          expect(Array.isArray(body.peers)).toBe(true)
          expect(body.peers.length).toBe(0)
          expect(typeof body.pendingMessages).toBe("number")
          expect(Array.isArray(body.recentActivity)).toBe(true)
        }),
      )
    }),
  )

  it.live("GET /global/mesh/status with malformed parentSessionID returns 400", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const response = yield* Effect.succeed(
            HttpClientRequest.get(`${GlobalPaths.meshStatus}?parentSessionID=not-a-session-id`),
          ).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(400)
        }),
      )
    }),
  )

  it.live("GET /global/mesh/status without parentSessionID returns 400", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const response = yield* Effect.succeed(
            HttpClientRequest.get(GlobalPaths.meshStatus),
          ).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(400)
        }),
      )
    }),
  )
})