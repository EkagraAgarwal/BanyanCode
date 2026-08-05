import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { sql } from "drizzle-orm"
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

const buildApiLayer = (dbPath: string, { withCodegraphRepo = true } = {}) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const busLayer = Banyan.subagentBusDefaultLayer.pipe(Layer.provide(dbLayer))
  const plansLayer = Banyan.subagentPlansRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const meshLayer = Banyan.meshCoordinatorDefaultLayer.pipe(
    Layer.provide(busLayer),
    Layer.provide(plansLayer),
    Layer.provide(dbLayer),
    Layer.provide(EventV2.defaultLayer),
  )
  const codegraphRepoLayer = withCodegraphRepo
    ? Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
    : Layer.empty

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
      Layer.provide(codegraphRepoLayer),
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
      const dbPath = path.join(tmp.path, "tool-usage-http.sqlite")
      return yield* body(dbPath)
    } finally {
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }
  })

describe("tool usage HttpApi", () => {
  const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

  it.live("GET /global/tool-usage returns recorded usage rows", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
            yield* db.run(sql`
              INSERT INTO codegraph_tool_usage (tool_id, last_used_at, use_count)
              VALUES ('code_find', 1722900000, 42)
            `)
            yield* db.run(sql`
              INSERT INTO codegraph_tool_usage (tool_id, last_used_at, use_count)
              VALUES ('blast_radius', 1722900100, 7)
            `)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const response = yield* Effect.succeed(HttpClientRequest.get(GlobalPaths.toolUsage)).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as {
            tools: Array<{ toolId: string; useCount: number; lastUsedAt: number }>
          }
          expect(body.tools.length).toBe(2)
          // Ordered by use_count DESC — code_find (42) before blast_radius (7).
          expect(body.tools[0]).toEqual({ toolId: "code_find", useCount: 42, lastUsedAt: 1722900000 })
          expect(body.tools[1]).toEqual({ toolId: "blast_radius", useCount: 7, lastUsedAt: 1722900100 })
        }),
      )
    }),
  )

  it.live("GET /global/tool-usage with an empty table returns 200 with an empty list", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const response = yield* Effect.succeed(HttpClientRequest.get(GlobalPaths.toolUsage)).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as { tools: unknown[] }
          expect(body.tools).toEqual([])
        }),
      )
    }),
  )

  it.live("GET /global/tool-usage without CodegraphRepo (BanyanCode disabled) returns an empty list", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath, { withCodegraphRepo: false })
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
            yield* db.run(sql`
              INSERT INTO codegraph_tool_usage (tool_id, last_used_at, use_count)
              VALUES ('code_find', 1722900000, 42)
            `)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const response = yield* Effect.succeed(HttpClientRequest.get(GlobalPaths.toolUsage)).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as { tools: unknown[] }
          expect(body.tools).toEqual([])
        }),
      )
    }),
  )
})
