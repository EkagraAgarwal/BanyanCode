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
import { mkdirSync } from "node:fs"
import path from "node:path"

// Same test-only route layer as codegraph-build-http.test.ts: the request
// context is deliberately an EMPTY context, so InstanceRef is NOT stamped
// (no InstanceContextMiddleware runs for /global/* routes). The status
// handler binds its OWN root-scoped Database via
// Database.layerFromRoot(identity.root), so the apiLayer dbPath is only used
// by the other (unexercised) handlers' deps.
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

// Seed a meta row (healthy: fresh + full coverage) into the canonical
// identity-derived DB for `root` — the exact file the status handler reads
// via Database.layerFromRoot(root).
const seedHealthyMeta = (root: string) =>
  Effect.gen(function* () {
    // Create the workspace-local marker FIRST so identityForRoot /
    // layerFromRoot resolve the banyan dir inside this tmp workspace instead
    // of walking up to an ancestor `.banyancode` (e.g. the user's home) and
    // writing real user data. Real workspaces get this marker when a build
    // first runs, so this mirrors production.
    mkdirSync(path.join(root, ".banyancode"), { recursive: true })
    const identity = Banyan.WorkspaceIdentity.identityForRoot(root)
    const seedLayer = Banyan.codegraphRepoLayer.pipe(
      Layer.provide(Database.layerFromPath(identity.dbPath)),
    )
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* Banyan.CodegraphRepo
        yield* repo.putFile({
          id: "f1",
          path: path.join(root, "a.ts"),
          contentHash: "h1",
          language: "typescript",
          indexedAt: Date.now(),
        })
        yield* repo.setMeta({
          id: "singleton",
          graphBuiltAt: Date.now(),
          graphVersion: 3,
          graphCoverage: 0.95,
          totalFiles: 1,
          totalNodes: 2,
          totalEdges: 1,
          schemaVersion: 3,
          indexedRoot: identity.root,
        })
      }).pipe(Effect.provide(seedLayer)),
    )
  })

describe("GET /global/codegraph-status", () => {
  it.live("reports ready with meta fields for a root whose graph is healthy", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-status-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)
        const root = path.join(tmp.path, "ws")
        mkdirSync(root, { recursive: true })

        yield* seedHealthyMeta(root)

        const response = yield* HttpClient.execute(
          HttpClientRequest.get(`${GlobalPaths.codegraphStatus}?root=${encodeURIComponent(root)}`),
        ).pipe(Effect.provide(apiLayer))
        expect(response.status).toBe(200)
        const data = (yield* response.json) as {
          reason: string
          autoBuilt: boolean
          graphBuiltAt?: number
          graphVersion?: number
          graphCoverage?: number
          totalFiles?: number
          warning?: string
          error?: string
        }
        expect(data.reason).toBe("ready")
        expect(data.autoBuilt).toBe(false)
        expect(data.graphBuiltAt).toBeGreaterThan(0)
        expect(data.graphVersion).toBe(3)
        expect(data.graphCoverage).toBe(0.95)
        expect(data.totalFiles).toBe(1)
        expect(data.warning).toBeUndefined()
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("reports missing for an existing root with no graph data", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-status-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)
        const emptyRoot = path.join(tmp.path, "empty-ws")
        mkdirSync(path.join(emptyRoot, ".banyancode"), { recursive: true })

        const response = yield* HttpClient.execute(
          HttpClientRequest.get(`${GlobalPaths.codegraphStatus}?root=${encodeURIComponent(emptyRoot)}`),
        ).pipe(Effect.provide(apiLayer))
        expect(response.status).toBe(200)
        const data = (yield* response.json) as { reason: string; autoBuilt: boolean }
        expect(data.reason).toBe("missing")
        expect(data.autoBuilt).toBe(false)
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("returns 400 when no root is supplied and no instance context exists", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-status-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)

        const response = yield* HttpClient.execute(HttpClientRequest.get(GlobalPaths.codegraphStatus)).pipe(Effect.provide(apiLayer))
        expect(response.status).toBe(400)
        const data = (yield* response.json) as { message?: string }
        expect(data.message).toContain("root")
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("returns 400 for a non-existent root with the identity error message", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-status-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)
        const missingRoot = path.join(tmp.path, "does-not-exist")

        const response = yield* HttpClient.execute(
          HttpClientRequest.get(`${GlobalPaths.codegraphStatus}?root=${encodeURIComponent(missingRoot)}`),
        ).pipe(Effect.provide(apiLayer))
        expect(response.status).toBe(400)
        const data = (yield* response.json) as { message?: string }
        expect(data.message).toContain("does not exist")
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )

  it.live("returns 400 refusing to index a filesystem-root root", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      try {
        const dbPath = path.join(tmp.path, "codegraph-status-http.sqlite")
        const apiLayer = buildApiLayer(dbPath)
        const driveRoot = path.parse(process.cwd()).root

        const response = yield* HttpClient.execute(
          HttpClientRequest.get(`${GlobalPaths.codegraphStatus}?root=${encodeURIComponent(driveRoot)}`),
        ).pipe(Effect.provide(apiLayer))
        expect(response.status).toBe(400)
        const data = (yield* response.json) as { message?: string }
        expect(data.message).toContain("refusing to index filesystem root")
      } finally {
        yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
      }
    }),
  )
})
