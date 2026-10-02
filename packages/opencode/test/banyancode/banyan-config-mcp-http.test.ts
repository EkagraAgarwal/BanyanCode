import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Option } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { BanyanConfig } from "@opencode-ai/core/v1/config/banyan-config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { repositoryIntelHandlers } from "../../src/server/routes/instance/httpapi/handlers/repository-intel"
import { memoryHandlers } from "../../src/server/routes/instance/httpapi/handlers/memory"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { repositoryIntelServiceMocks } from "../server/repository-intel-mocks"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { testEffect } from "../lib/effect"

const banyanConfigMock = Layer.mock(Banyan.BanyanConfigService)({
  get: () => Effect.succeed({}),
  update: (patch: Partial<BanyanConfig.Info>) => Effect.succeed(patch as BanyanConfig.Info),
})

const eventsMock = Layer.succeed(
  EventV2Bridge.Service,
  EventV2Bridge.Service.of({
    publish: (def: unknown, data: unknown) =>
      Effect.gen(function* () {
        yield* Effect.void
        return data
      }),
    listen: () => Effect.succeed(() => Effect.void),
  } as any),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, repositoryIntelHandlers, memoryHandlers]),
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
  Layer.provide(banyanConfigMock),
  Layer.provide(eventsMock),
)

const it = testEffect(apiLayer)

describe("PATCH /global/banyan-config mcp_server tools", () => {
  it.live("accepts single-element tools array", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch(GlobalPaths.banyanConfig).pipe(
        HttpClientRequest.bodyJson({ config: { banyancode_mcp_server: { tools: ["code"] } } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { banyancode_mcp_server?: { tools?: string[] } }
      expect(body.banyancode_mcp_server?.tools).toEqual(["code"])
    }),
  )

  it.live("accepts multi-element tools array", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch(GlobalPaths.banyanConfig).pipe(
        HttpClientRequest.bodyJson({ config: { banyancode_mcp_server: { tools: ["code", "task"] } } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      const body = (yield* response.json) as { banyancode_mcp_server?: { tools?: string[] } }
      expect(body.banyancode_mcp_server?.tools).toEqual(["code", "task"])
    }),
  )

  it.live("rejects string-typed tools (not an array)", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.patch(GlobalPaths.banyanConfig).pipe(
        HttpClientRequest.bodyJson({ config: { banyancode_mcp_server: { tools: "code" } } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(400)
    }),
  )
})
