import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { MemoryPaths } from "../../src/server/routes/instance/httpapi/groups/memory"
import { memoryHandlers } from "../../src/server/routes/instance/httpapi/handlers/memory"
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
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import path from "path"

const buildApiLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const memoryLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
  const memoryServiceLayer = Banyan.memoryServiceLayer.pipe(
    Layer.provide(memoryLayer as Layer.Layer<never, never, never>),
    Layer.provide(dbLayer),
  )
  const memoryProjectionLayer = Banyan.memoryProjectionLayer.pipe(
    Layer.provide(memoryLayer as Layer.Layer<never, never, never>),
    Layer.provide(dbLayer),
  )

  // Merge repo + service + projection so handlers reading any of them get the same DB.
  const memoryLayerFinal = Layer.merge(Layer.merge(memoryLayer, memoryServiceLayer), memoryProjectionLayer)

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
      Layer.provide(memoryLayerFinal),
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

const makePost = (path: string, body: unknown) =>
  HttpClientRequest.post(path).pipe(
    HttpClientRequest.bodyJson(body as Record<string, unknown>),
    Effect.flatMap(HttpClient.execute),
  )

const runWithFreshDb = <A, E, R>(
  body: (dbPath: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.promise(() => tmpdir())
    try {
      const dbPath = path.join(tmp.path, "memory-http.sqlite")
      return yield* body(dbPath)
    } finally {
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }
  })

describe("memory HttpApi", () => {
  const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

  it.live("store → list → search round-trip works against a real DB", () =>
    Effect.gen(function* () {
      const result = yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)

          // Migrations run inside the same DB connection the tests will hit.
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const storeResponse = yield* makePost(MemoryPaths.store, {
            key: "user:bun",
            scope: "global",
            value: {
              kind: "preference",
              title: "Use Bun runtime",
              body: "Project runs on Bun, not Node.",
              source: { type: "user" },
              confidence: "high",
              importance: "high",
              status: "active",
            },
            tags: ["runtime", "bun"],
          }).pipe(Effect.provide(apiLayer))
          expect(storeResponse.status).toBe(200)
          const stored = (yield* storeResponse.json) as { id: string; version: number }
          expect(stored.id).toBeString()
          expect(stored.version).toBe(1)

          const listResponse = yield* makePost(MemoryPaths.list, { scope: "global" }).pipe(
            Effect.provide(apiLayer),
          )
          expect(listResponse.status).toBe(200)
          const listed = (yield* listResponse.json) as Array<{ key: string; kind?: string }>
          expect(listed.length).toBe(1)
          expect(listed[0]?.key).toBe("user:bun")
          expect(listed[0]?.kind).toBe("preference")

          const searchResponse = yield* makePost(MemoryPaths.search, {
            query: "Bun runtime",
            scope: "global",
          }).pipe(Effect.provide(apiLayer))
          expect(searchResponse.status).toBe(200)
          const searched = (yield* searchResponse.json) as {
            entries: Array<{ key: string }>
            totalHits: number
          }
          expect(searched.totalHits).toBe(1)
          expect(searched.entries[0]?.key).toBe("user:bun")

          const forgetResponse = yield* makePost(MemoryPaths.forget, { id: stored.id }).pipe(
            Effect.provide(apiLayer),
          )
          expect(forgetResponse.status).toBe(200)
          const forgot = (yield* forgetResponse.json) as { removed: number }
          expect(forgot.removed).toBe(1)
        }),
      )
      return result
    }),
  )

  it.live("store rejects keys that fail the pattern check", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)
          const response = yield* makePost(MemoryPaths.store, {
            key: "../../etc/passwd",
            scope: "global",
            value: "dangerous",
          }).pipe(Effect.provide(apiLayer))
          expect(response.status).toBe(400)
        }),
      )
    }),
  )

  it.live("search filters by status", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          yield* makePost(MemoryPaths.store, {
            key: "decision:active",
            scope: "global",
            value: {
              kind: "decision",
              title: "Use Turso",
              body: "Storage backend is Turso.",
              source: { type: "agent" },
              confidence: "high",
              importance: "high",
              status: "active",
            },
          }).pipe(Effect.provide(apiLayer))

          yield* makePost(MemoryPaths.store, {
            key: "decision:superseded",
            scope: "global",
            value: {
              kind: "decision",
              title: "Use raw SQLite",
              body: "Originally planned raw SQLite.",
              source: { type: "agent" },
              confidence: "low",
              importance: "low",
              status: "superseded",
            },
          }).pipe(Effect.provide(apiLayer))

          const response = yield* makePost(MemoryPaths.search, {
            query: "decision",
            scope: "global",
            status: "active",
          }).pipe(Effect.provide(apiLayer))
          expect(response.status).toBe(200)
          const body = (yield* response.json) as { entries: Array<{ key: string }>; totalHits: number }
          expect(body.totalHits).toBe(1)
          expect(body.entries[0]?.key).toBe("decision:active")
        }),
      )
    }),
  )

  it.live("summary returns totalActive, byKind, and empty digests for empty store", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          const response = yield* makePost(MemoryPaths.summary, { scope: "global" }).pipe(
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as {
            totalActive: number
            byKind: Array<{ kind: string; count: number }>
            decisionDigest: Array<{ title: string }>
            warningDigest: Array<{ title: string }>
          }
          expect(body.totalActive).toBe(0)
          expect(body.byKind).toEqual([])
          expect(body.decisionDigest).toEqual([])
          expect(body.warningDigest).toEqual([])
        }),
      )
    }),
  )

  it.live("summary includes decisionDigest entries when decisions are stored", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          yield* makePost(MemoryPaths.store, {
            key: "decision:db",
            scope: "global",
            value: {
              kind: "decision",
              title: "Use Turso",
              body: "Storage backend is Turso.",
              source: { type: "user" },
              confidence: "high",
              importance: "high",
              status: "active",
            },
          }).pipe(Effect.provide(apiLayer))

          const response = yield* makePost(MemoryPaths.summary, { scope: "global" }).pipe(
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const body = (yield* response.json) as {
            totalActive: number
            byKind: Array<{ kind: string; count: number }>
            decisionDigest: Array<{ title: string; kind: string }>
          }
          expect(body.totalActive).toBe(1)
          expect(body.byKind).toEqual([{ kind: "decision", count: 1 }])
          expect(body.decisionDigest.length).toBe(1)
          expect(body.decisionDigest[0]?.title).toBe("Use Turso")
          expect(body.decisionDigest[0]?.kind).toBe("decision")
        }),
      )
    }),
  )

  it.live("store persists status=pending from a full MemoryPayloadV1 value", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const apiLayer = buildApiLayer(dbPath)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          // Exact shape the [+ Add memory] dialog sends — full MemoryPayloadV1
          // embedded in `value` with status="pending".
          const storeResponse = yield* makePost(MemoryPaths.store, {
            key: "user:draft",
            scope: "global",
            value: {
              kind: "observation",
              title: "Why we use Effect v4 over v3",
              body: "Smaller surface area; better fiber handling.",
              source: { type: "user" },
              confidence: "medium",
              importance: "medium",
              status: "pending",
            },
          }).pipe(Effect.provide(apiLayer))
          expect(storeResponse.status).toBe(200)
          const stored = (yield* storeResponse.json) as { id: string; version: number }

          // List reflects the pending row (status default = any).
          const listResponse = yield* makePost(MemoryPaths.list, { scope: "global" }).pipe(
            Effect.provide(apiLayer),
          )
          expect(listResponse.status).toBe(200)
          const listed = (yield* listResponse.json) as Array<{
            id: string
            key: string
            status?: string
          }>
          const storedRow = listed.find((e) => e.id === stored.id)
          expect(storedRow?.key).toBe("user:draft")
          expect(storedRow?.status).toBe("pending")

          // The candidates endpoint (status=pending filter) returns this row.
          const candidatesResponse = yield* makePost(MemoryPaths.candidates, {
            scope: "global",
            status: "pending",
          }).pipe(Effect.provide(apiLayer))
          expect(candidatesResponse.status).toBe(200)
          const candidates = (yield* candidatesResponse.json) as {
            entries: Array<{ id: string; status?: string }>
            count: number
          }
          expect(candidates.count).toBe(1)
          expect(candidates.entries[0]?.id).toBe(stored.id)
          expect(candidates.entries[0]?.status).toBe("pending")
        }),
      )
    }),
  )
})