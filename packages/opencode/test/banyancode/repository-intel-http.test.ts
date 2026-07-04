import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Option } from "effect"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { RepositoryIntelPaths } from "../../src/server/routes/instance/httpapi/groups/repository-intel"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { repositoryIntelHandlers } from "../../src/server/routes/instance/httpapi/handlers/repository-intel"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { repositoryIntelServiceMocks } from "../server/repository-intel-mocks"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, repositoryIntelHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
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

const it = testEffect(apiLayer)

describe("repository-intel HttpApi", () => {
  it.live("findSubsystem returns entry and related", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(RepositoryIntelPaths.findSubsystem).pipe(
        HttpClientRequest.bodyJson({ query: "CodegraphRepo" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { entry: { name: string }; related: unknown[] }
      expect(body.entry.name).toBe("empty")
      expect(Array.isArray(body.related)).toBe(true)
    }),
  )

  it.live("search returns results array", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(RepositoryIntelPaths.search).pipe(
        HttpClientRequest.bodyJson({ query: "build", modes: ["fuzzy"] }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      expect(Array.isArray(yield* response.json)).toBe(true)
    }),
  )
})
