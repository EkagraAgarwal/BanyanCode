import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Banyan } from "@opencode-ai/core/banyancode"
import { resolveWorkspaceRoot } from "@opencode-ai/core/banyancode/workspace-root"
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
import { tmpdir } from "../fixture/tmpdir"
import { mkdirSync } from "node:fs"
import path from "node:path"

process.env.BANYANCODE_ENABLE = "1"

// Same test-only route layer as codegraph-status-http.test.ts: /global/* runs
// with an EMPTY request context, so InstanceRef is not stamped. The status
// handler binds its own root-scoped Database via
// Database.layerFromRoot(identity.root) per request.
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

// Seed a meta row into the identity-derived DB for `root` — the exact file a
// root-bound tool layer (`Database.layerFromRoot(root)`) and the status
// handler (`identityForRoot(root)`) both read.
const seedGraph = (root: string, graphBuiltAt: number) =>
  Effect.gen(function* () {
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
          graphBuiltAt,
          graphVersion: 3,
          graphCoverage: 0.9,
          totalFiles: 1,
          totalNodes: 2,
          totalEdges: 1,
          schemaVersion: 3,
          indexedRoot: identity.root,
        })
      }).pipe(Effect.provide(seedLayer)),
    )
  })

// Regression for unify-runtime-root: the codegraph graph identity is resolved
// from the SELECTED WORKTREE (via `WorktreeContext` → `resolveWorkspaceRoot`),
// not from the server's `process.cwd()`. A server launched from a different
// directory must still read and write the same DB file as the status endpoint,
// slash commands, and the TUI progress bridge. This test seeds a graph for a
// tmp worktree, binds the root-bound repo layer to the WorktreeContext, and
// asserts BOTH the tool-side graph read AND /global/codegraph-status observe
// the same seeded meta — even though process.cwd() differs from the worktree.
describe("same graph identity across tool layer and status endpoint", () => {
  test("tools and /global/codegraph-status resolve the SAME root-bound DB when cwd differs from the worktree", async () => {
    await using tmp = await tmpdir()
    const worktree = path.join(tmp.path, "ws")
    mkdirSync(worktree, { recursive: true })
    const graphBuiltAt = Date.now()

    await Effect.runPromise(seedGraph(worktree, graphBuiltAt))

    // The tool-side root-bound repo layer: resolves the canonical root through
    // `resolveWorkspaceRoot` (which reads WorktreeContext), then binds the DB
    // with Database.layerFromRoot — mirroring banyan-tools-mount.ts.
    const rootBoundDatabaseLayer = Layer.unwrap(
      Effect.gen(function* () {
        const root = yield* resolveWorkspaceRoot({})
        return Database.layerFromRoot(root)
      }),
    )
    const toolLayer = Banyan.codegraphRepoLayer.pipe(
      Layer.provide(rootBoundDatabaseLayer),
      Layer.provide(Layer.succeed(Banyan.WorktreeContext, () => Effect.succeed<string | undefined>(worktree))),
    )

    // Override process.cwd() to a DIFFERENT directory than the worktree so the
    // test genuinely exercises the cwd-mismatch path: without the root-bound
    // resolution, a cwd-derived DB would be a different file and getMeta would
    // return undefined.
    const originalCwd = process.cwd()
    const fakeCwd = path.join(tmp.path, "server-cwd")
    mkdirSync(fakeCwd, { recursive: true })
    process.chdir(fakeCwd)
    try {
      expect(path.resolve(process.cwd())).not.toBe(path.resolve(worktree))

      const toolMeta = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const repo = yield* Banyan.CodegraphRepo
            return yield* repo.getMeta()
          }).pipe(Effect.provide(toolLayer)),
        ),
      )
      expect(toolMeta).toBeDefined()
      if (!toolMeta) throw new Error("expected tool-side getMeta to return the seeded meta")
      expect(toolMeta.graphBuiltAt).toBe(graphBuiltAt)
      expect(toolMeta.totalFiles).toBe(1)
      expect(toolMeta.indexedRoot).toBe(path.resolve(worktree))

      // The status endpoint derives its DB from the SAME root via
      // identityForRoot → Database.layerFromRoot. Assert it observes the same
      // seeded meta.
      const dbPath = path.join(tmp.path, "status-api.sqlite")
      const apiLayer = buildApiLayer(dbPath)
      const response = await Effect.runPromise(
        HttpClient.execute(
          HttpClientRequest.get(`${GlobalPaths.codegraphStatus}?root=${encodeURIComponent(worktree)}`),
        ).pipe(Effect.provide(apiLayer)),
      )
      expect(response.status).toBe(200)
      const data = (await Effect.runPromise(response.json)) as { reason: string; graphBuiltAt?: number; totalFiles?: number }
      expect(data.reason).toBe("ready")
      expect(data.graphBuiltAt).toBe(graphBuiltAt)
      expect(data.totalFiles).toBe(1)
    } finally {
      process.chdir(originalCwd)
    }
  })

  test("resolveWorkspaceRoot prefers WorktreeContext over process.cwd()", async () => {
    await using tmp = await tmpdir()
    const worktree = path.join(tmp.path, "ws")
    mkdirSync(worktree, { recursive: true })

    const originalCwd = process.cwd()
    const fakeCwd = path.join(tmp.path, "server-cwd")
    mkdirSync(fakeCwd, { recursive: true })
    process.chdir(fakeCwd)
    try {
      // No WorktreeContext provided → falls back to repo-root discovery from cwd.
      const fallback = await Effect.runPromise(resolveWorkspaceRoot({}))
      expect(fallback).not.toBe(path.resolve(worktree))

      // WorktreeContext provided → wins over the (different) server cwd.
      const withWorktree = await Effect.runPromise(
        resolveWorkspaceRoot({}).pipe(
          Effect.provide(Layer.succeed(Banyan.WorktreeContext, () => Effect.succeed<string | undefined>(worktree))),
        ),
      )
      expect(withWorktree).toBe(path.resolve(worktree))
    } finally {
      process.chdir(originalCwd)
    }
  })
})
