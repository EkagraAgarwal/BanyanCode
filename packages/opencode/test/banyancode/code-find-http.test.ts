import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { resolveGraphTargetPure } from "@opencode-ai/core/banyancode/symbol-resolver"
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
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import path from "path"

// Fixture graph: one file, one function node, and a meta row marking the
// graph ready (schemaVersion = CODEGRAPH_SCHEMA_VERSION = 3, fresh builtAt,
// healthy coverage) so the readiness path short-circuits.
const FIXTURE_FILE = {
  id: "f-widget",
  path: "src/widget.ts",
  contentHash: "h1",
  language: "ts",
  indexedAt: Date.now(),
}
const FIXTURE_NODE = {
  id: "n-widget",
  fileID: "f-widget",
  kind: "function" as const,
  name: "MyWidget",
  startLine: 1,
  endLine: 10,
}
const FIXTURE_META = {
  id: "singleton",
  graphBuiltAt: Date.now(),
  graphVersion: 1,
  graphCoverage: 0.9,
  totalFiles: 1,
  totalNodes: 1,
  totalEdges: 0,
  schemaVersion: 3,
}

// The handler yields PermissionV2.Service directly, so the API layer must
// provide it. A mock that always allows keeps the test focused on the route.
const mockPermissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: () => Effect.succeed({ id: { _id: "p" } as never, effect: "allow" as const }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

// definition/callers/dependents/impact intents exercise the analyzer; the
// definition intent used here never calls it, but the handler yields the
// service so it must be present.
const mockAnalyzerLayer = Layer.succeed(
  Banyan.CodegraphAnalyzer,
  Banyan.CodegraphAnalyzer.of({
    callers: () => Effect.succeed([]),
    dependents: () => Effect.succeed([]),
    impact: () => Effect.succeed({ dependents: [], transitive: [] }),
    walkTransitive: () => Effect.succeed([]),
  }),
)

// Mocked readiness: `ready` without a rebuild — the fixture meta is already
// structurally valid, and we do not want ensureReady to kick off a real
// codegraph build against process.cwd().
const mockReadinessLayer = Layer.succeed(
  Banyan.CodegraphReadiness,
  Banyan.CodegraphReadiness.of({
    ensureReady: () => Effect.succeed({ reason: "ready" as const, autoBuilt: false }),
    status: () => Effect.succeed({ reason: "ready" as const, autoBuilt: false }),
  }),
)

// `codegraphRepoLayer` is threaded through: the same layer value is provided
// to the API handlers AND provided into the test body, so Effect's per-run
// MemoMap builds it once and the HTTP handler + the in-agent resolver below
// operate on the exact same CodegraphRepo instance.
const buildApiLayer = (dbPath: string, codegraphRepoLayer: Layer.Layer<Banyan.CodegraphRepo, never, never>) => {
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
      Layer.provide(codegraphRepoLayer),
      Layer.provide(mockPermissionLayer),
      Layer.provide(mockAnalyzerLayer),
      Layer.provide(mockReadinessLayer),
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
      const dbPath = path.join(tmp.path, "code-find-http.sqlite")
      return yield* body(dbPath)
    } finally {
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }
  })

describe("code-find HttpApi", () => {
  const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

  it.live("POST /global/code-find returns the same node IDs as the in-agent resolver", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
          const apiLayer = buildApiLayer(dbPath, repoLayer)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          // Fixture insertion, the HTTP call, and the in-agent resolver all
          // run inside ONE scoped provide of apiLayer + repoLayer. Because
          // the same repoLayer value feeds both the handlers and this body,
          // the parity assertion below is against the exact repo instance
          // the handler executed against.
          yield* Effect.gen(function* () {
            const repo = yield* Banyan.CodegraphRepo
            yield* repo.putFile(FIXTURE_FILE)
            yield* repo.putNode(FIXTURE_NODE)
            yield* repo.setMeta(FIXTURE_META)

            const response = yield* HttpClientRequest.post(GlobalPaths.codeFind).pipe(
              HttpClientRequest.bodyJson({ intent: "definition", target: "MyWidget", includeKeywordFallback: true }),
              Effect.flatMap(HttpClient.execute),
            )
            expect(response.status).toBe(200)
            const body = (yield* response.json) as {
              matches: Array<{ node: { id: string }; derivation: string }>
              resolvedNodeID?: string
              resolvedDerivation?: string
              _diagnostic?: string
            }
            expect(body.matches.length).toBeGreaterThan(0)
            expect(body.matches[0]!.node.id).toBe("n-widget")
            expect(body.resolvedNodeID).toBe("n-widget")
            expect(body.resolvedDerivation).toBe("name-exact")

            // Acceptance criterion: the HTTP response node IDs match what
            // the in-agent resolver returns for the same input against the
            // same repo.
            const resolved = yield* resolveGraphTargetPure(repo as never, { target: "MyWidget" })
            expect(resolved._tag).toBe("Ok")
            if (resolved._tag === "Ok") {
              expect(body.resolvedNodeID).toBe(resolved.value.nodeID)
              expect(body.matches[0]!.node.id).toBe(resolved.value.nodeID)
            }
          }).pipe(Effect.scoped, Effect.provide(apiLayer), Effect.provide(repoLayer))
        }),
      )
    }),
  )

  it.live("POST /global/code-find with an unresolvable target returns 200 + empty matches + _diagnostic", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((dbPath) =>
        Effect.gen(function* () {
          const dbLayer = Database.layerFromPath(dbPath)
          const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
          const apiLayer = buildApiLayer(dbPath, repoLayer)
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* DatabaseMigration.apply(db)
          }).pipe(Effect.provide(dbLayer), Effect.scoped)

          yield* Effect.gen(function* () {
            const repo = yield* Banyan.CodegraphRepo
            yield* repo.putFile(FIXTURE_FILE)
            yield* repo.putNode(FIXTURE_NODE)
            yield* repo.setMeta(FIXTURE_META)

            const response = yield* HttpClientRequest.post(GlobalPaths.codeFind).pipe(
              HttpClientRequest.bodyJson({ intent: "definition", target: "Nope_Not_Indexed_12345", includeKeywordFallback: true }),
              Effect.flatMap(HttpClient.execute),
            )
            expect(response.status).toBe(200)
            const body = (yield* response.json) as {
              matches: unknown[]
              _diagnostic?: string
            }
            expect(body.matches).toEqual([])
            expect(body._diagnostic).toBe("target-not-resolved")
          }).pipe(Effect.scoped, Effect.provide(apiLayer), Effect.provide(repoLayer))
        }),
      )
    }),
  )
})
