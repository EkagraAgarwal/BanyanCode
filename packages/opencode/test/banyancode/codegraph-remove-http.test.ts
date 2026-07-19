import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventV2 } from "@opencode-ai/core/event"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
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
import * as fs from "node:fs/promises"
import * as os from "node:os"
import path from "node:path"

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

const seedFixture = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* DatabaseMigration.apply(db)
  const repo = yield* CodegraphRepo.Service
  yield* repo.putFile({ id: "f1", path: "src/a.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
  yield* repo.putFile({ id: "f2", path: "src/b.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
  yield* repo.putNode({ id: "n1", fileID: "f1", kind: "function", name: "Alpha", signature: "Alpha()", startLine: 1, endLine: 2, code: "function Alpha(){}" })
  yield* repo.putNode({ id: "n2", fileID: "f2", kind: "function", name: "Beta", signature: "Beta()", startLine: 1, endLine: 2, code: "function Beta(){}" })
})

const runWithFreshDb = <A, E>(body: (dbPath: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.promise(() => tmpdir())
    try {
      const dbPath = path.join(tmp.path, "codegraph-remove-http.sqlite")
      return yield* body(dbPath)
    } finally {
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }
  })

const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

describe("POST /global/codegraph-remove", () => {
  it.live("dropFile:false clears rows but keeps the DB file on disk", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
          const apiLayer = buildApiLayer(dbPath)
          let beforePresent = false
          let afterPresent = true
          yield* Effect.gen(function* () {
            yield* seedFixture
            const repo = yield* CodegraphRepo.Service
            const before = yield* repo.getFile("f1")
            beforePresent = before !== undefined
          }).pipe(Effect.provide(dbLayer), Effect.provide(repoLayer), Effect.scoped)
          expect(beforePresent).toBe(true)

          const response = yield* HttpClientRequest.post(GlobalPaths.codegraphRemove).pipe(
            HttpClientRequest.bodyJson({ dropFile: false }),
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const data = (yield* response.json) as {
            sizeBefore: number
            sizeAfter: number
            droppedFile: boolean
          }
          expect(data.droppedFile).toBe(false)

          yield* Effect.gen(function* () {
            const repo = yield* CodegraphRepo.Service
            const after = yield* repo.getFile("f1")
            afterPresent = after !== undefined
          }).pipe(Effect.provide(dbLayer), Effect.provide(repoLayer), Effect.scoped)
          expect(afterPresent).toBe(false)

          const dbExists = yield* Effect.promise(() =>
            fs.access(dbPath).then(() => true, () => false),
          )
          expect(dbExists).toBe(true)
        }),
      )
    }),
  )

  it.live("dropFile:true unlinks the DB file on POSIX, no-ops on Windows EBUSY", () =>
    Effect.gen(function* () {
      const isWindows = os.platform() === "win32"
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
          const apiLayer = buildApiLayer(dbPath)
          yield* seedFixture.pipe(Effect.provide(dbLayer), Effect.provide(repoLayer), Effect.scoped)

          const response = yield* HttpClientRequest.post(GlobalPaths.codegraphRemove).pipe(
            HttpClientRequest.bodyJson({ dropFile: true }),
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBe(200)
          const data = (yield* response.json) as {
            sizeBefore: number
            sizeAfter: number
            droppedFile: boolean
          }
          if (isWindows) {
            expect(data.droppedFile).toBe(false)
          } else {
            expect(data.droppedFile).toBe(true)
          }
        }),
      )
    }),
  )

  it.live("dropFile:'yes' (wrong type) returns 400", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
          const apiLayer = buildApiLayer(dbPath)
          yield* seedFixture.pipe(Effect.provide(dbLayer), Effect.provide(repoLayer), Effect.scoped)

          const response = yield* HttpClientRequest.post(GlobalPaths.codegraphRemove).pipe(
            HttpClientRequest.bodyJson({ dropFile: "yes" }),
            Effect.flatMap(HttpClient.execute),
            Effect.provide(apiLayer),
          )
          expect(response.status).toBeGreaterThanOrEqual(400)
          expect(response.status).toBeLessThan(500)
        }),
      )
    }),
  )
})