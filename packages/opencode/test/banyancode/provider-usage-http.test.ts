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
import {
  globalHandlers,
} from "../../src/server/routes/instance/httpapi/handlers/global"
import { ProviderUsage } from "../../src/provider/usage"
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

interface UsageMock {
  snapshots: Banyan.ProviderUsageSnapshot[]
  refresh: Banyan.ProviderUsageSnapshot[]
  seen: Array<string | undefined>
}

const availableSnapshot = new Banyan.ProviderUsageSnapshot({
  providerID: "openai",
  displayName: "OpenAI",
  status: "available",
  confidence: "reported",
  windows: [
    new Banyan.ProviderUsageWindow({
      id: "requests",
      label: "Requests",
      kind: "rate_limit",
      limit: 100,
      remaining: 62,
    }),
  ],
  fetchedAt: 1722900000000,
})

const errorSnapshot = new Banyan.ProviderUsageSnapshot({
  providerID: "gemini",
  displayName: "Gemini",
  status: "error",
  confidence: "estimated",
  windows: [],
  message: "Usage unavailable for this provider.",
  fetchedAt: 1722900000000,
})

// Same test-only route layer as codegraph-build-http.test.ts: the request
// context is deliberately an EMPTY context, so no session is ever active and
// InstanceRef is NOT stamped (no InstanceContextMiddleware runs for /global/*
// routes). Every test below therefore proves the provider-usage routes work
// without an active session.
const buildApiLayer = (dbPath: string, usage?: UsageMock) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const busLayer = Banyan.subagentBusDefaultLayer.pipe(Layer.provide(dbLayer))
  const plansLayer = Banyan.subagentPlansRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const meshLayer = Banyan.meshCoordinatorDefaultLayer.pipe(
    Layer.provide(busLayer),
    Layer.provide(plansLayer),
    Layer.provide(dbLayer),
    Layer.provide(EventV2.defaultLayer),
  )
  const usageLayer = usage
    ? Layer.succeed(ProviderUsage.Service, {
        snapshots: () => Effect.succeed([...usage.snapshots]),
        refresh: (providerID?: string) =>
          Effect.sync(() => {
            usage.seen.push(providerID)
            return [...usage.refresh]
          }),
      })
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
      Layer.provide(dbLayer),
      Layer.provide(usageLayer),
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
      const dbPath = path.join(tmp.path, "provider-usage-http.sqlite")
      return yield* body(dbPath)
    } finally {
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }
  })

const migrate = (dbPath: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* DatabaseMigration.apply(db)
  }).pipe(Effect.provide(Database.layerFromPath(dbPath)), Effect.scoped)

const FORBIDDEN = ["apiKey", "api_key", "Bearer", "authorization", "cookie", "secret", "sk-", "BEGIN PRIVATE"]

describe("provider usage HttpApi", () => {
  const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

  it.live("GET /global/provider-usage returns cached snapshots without an active session", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          yield* migrate(dbPath)
          const apiLayer = buildApiLayer(dbPath, {
            snapshots: [availableSnapshot, errorSnapshot],
            refresh: [availableSnapshot],
            seen: [],
          })

          const response = yield* Effect.succeed(HttpClientRequest.get(GlobalPaths.providerUsage)).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as { snapshots: Array<{ providerID: string }> }
          expect(body.snapshots.length).toBe(2)
          expect(body.snapshots[0]?.providerID).toBe("openai")
          expect(body.snapshots[1]?.providerID).toBe("gemini")
        }),
      )
    }),
  )

  it.live("POST /global/provider-usage/refresh with {} refreshes all providers", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          yield* migrate(dbPath)
          const mock: UsageMock = { snapshots: [], refresh: [availableSnapshot], seen: [] }
          const apiLayer = buildApiLayer(dbPath, mock)

          const response = yield* HttpClientRequest.post(GlobalPaths.providerUsageRefresh).pipe(
            HttpClientRequest.bodyJson({}),
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as { snapshots: Array<{ providerID: string }> }
          expect(body.snapshots.length).toBe(1)
          expect(body.snapshots[0]?.providerID).toBe("openai")
          expect(mock.seen).toEqual([undefined])
        }),
      )
    }),
  )

  it.live("POST /global/provider-usage/refresh with providerID refreshes one provider", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          yield* migrate(dbPath)
          const mock: UsageMock = { snapshots: [], refresh: [availableSnapshot], seen: [] }
          const apiLayer = buildApiLayer(dbPath, mock)

          const response = yield* HttpClientRequest.post(GlobalPaths.providerUsageRefresh).pipe(
            HttpClientRequest.bodyJson({ providerID: "openai" }),
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as { snapshots: Array<{ providerID: string }> }
          expect(body.snapshots.length).toBe(1)
          expect(mock.seen).toEqual(["openai"])
        }),
      )
    }),
  )

  it.live("POST /global/provider-usage/refresh rejects unsafe provider IDs with 400", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          yield* migrate(dbPath)
          const mock: UsageMock = { snapshots: [], refresh: [availableSnapshot], seen: [] }
          const apiLayer = buildApiLayer(dbPath, mock)

          for (const providerID of ["../../etc/passwd", "has space", "", "a/b"]) {
            const response = yield* HttpClientRequest.post(GlobalPaths.providerUsageRefresh).pipe(
              HttpClientRequest.bodyJson({ providerID }),
              Effect.flatMap(HttpClient.execute),
              Effect.provide(apiLayer),
            )
            expect(response.status).toBe(400)
          }
          // The service must never see rejected input.
          expect(mock.seen).toEqual([])
        }),
      )
    }),
  )

  it.live("POST /global/provider-usage/refresh with unknown safe ID returns empty list", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          yield* migrate(dbPath)
          const mock: UsageMock = { snapshots: [], refresh: [], seen: [] }
          const apiLayer = buildApiLayer(dbPath, mock)

          const response = yield* HttpClientRequest.post(GlobalPaths.providerUsageRefresh).pipe(
            HttpClientRequest.bodyJson({ providerID: "no-such-provider" }),
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as { snapshots: unknown[] }
          expect(body.snapshots).toEqual([])
          expect(mock.seen).toEqual(["no-such-provider"])
        }),
      )
    }),
  )

  it.live("partial adapter failure still encodes successful snapshots with no secrets", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          yield* migrate(dbPath)
          const apiLayer = buildApiLayer(dbPath, {
            snapshots: [availableSnapshot, errorSnapshot],
            refresh: [availableSnapshot, errorSnapshot],
            seen: [],
          })

          const response = yield* Effect.succeed(HttpClientRequest.get(GlobalPaths.providerUsage)).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as {
            snapshots: Array<{ providerID: string; status: string; message?: string }>
          }
          expect(body.snapshots.length).toBe(2)
          const failed = body.snapshots.find((snapshot) => snapshot.providerID === "gemini")
          expect(failed?.status).toBe("error")
          expect(failed?.message).toBe("Usage unavailable for this provider.")
          const raw = JSON.stringify(body)
          for (const forbidden of FORBIDDEN) {
            expect(raw.includes(forbidden)).toBe(false)
          }
        }),
      )
    }),
  )

  it.live("without the ProviderUsage service both routes return an empty snapshot list", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          yield* migrate(dbPath)
          const apiLayer = buildApiLayer(dbPath)

          const list = yield* Effect.succeed(HttpClientRequest.get(GlobalPaths.providerUsage)).pipe(
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(list.status).toBe(200)
          expect((yield* list.json) as { snapshots: unknown[] }).toEqual({ snapshots: [] })

          const refresh = yield* HttpClientRequest.post(GlobalPaths.providerUsageRefresh).pipe(
            HttpClientRequest.bodyJson({}),
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(refresh.status).toBe(200)
          expect((yield* refresh.json) as { snapshots: unknown[] }).toEqual({ snapshots: [] })
        }),
      )
    }),
  )
})
