// MCP code-intelligence tools: protocol tests (Phase 0 slice).
//
// Real McpServer + real MCP Client over an InMemoryTransport linked pair,
// handlers calling the real in-process HTTP routes via the typed SDK v2
// client, backed by a real tmpdir database (Database.layerFromPath +
// migrations + fixture rows). No mocked transports, no mocked SDK
// responses, no mocked database.
//
// Two narrow shims keep the suite headless (same shape as the
// code-find-http recipe): permission-allow (the real PermissionV2 needs a
// live session plus a user reply) and readiness-ready (the real readiness
// would kick off an index build against process.cwd()). Every service the
// tools touch — CodegraphRepo, CodegraphAnalyzer, RepositoryIntelligence,
// Git, the HTTP handlers — is real.

import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { repositoryIntelHandlers } from "../../src/server/routes/instance/httpapi/handlers/repository-intel"
import { memoryHandlers } from "../../src/server/routes/instance/httpapi/handlers/memory"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import path from "path"
import {
  CODE_TOOL_OUTPUT_MAX_CHARS,
  CodeToolNames,
  OUTPUT_TRUNCATED_MARKER,
  capOutput,
  isChangeCheckOp,
  isCodegraphOp,
  isInsideRoot,
  isRepoOp,
  registerCodeTools,
  resolveChangeCheckRoute,
  resolveCodegraphRoute,
  resolveRepoRoute,
} from "../../src/mcp-server/tools-code"

// Fixture graph (mirrors code-find-http.test.ts): one file, function
// node(s), and a ready meta row (schemaVersion 3) so readiness would
// short-circuit even without the ready-shim.
const FIXTURE_FILE = {
  id: "f-widget",
  path: "src/widget.ts",
  contentHash: "h1",
  language: "ts",
  indexedAt: Date.now(),
}
const fixtureNode = (n: number) => ({
  id: `n-widget-${n}`,
  fileID: "f-widget",
  kind: "function" as const,
  name: "MyWidget",
  startLine: 1,
  endLine: 10,
})
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

// Headless allow-all permission: tools run under session "global", which has
// no live session record for the real PermissionV2 to reply on.
const allowPermissionLayer = Layer.succeed(
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

// Headless ready readiness: the fixture meta is already fresh, and a real
// ensureReady would kick off an index build against process.cwd().
const readyReadinessLayer = Layer.succeed(
  Banyan.CodegraphReadiness,
  Banyan.CodegraphReadiness.of({
    ensureReady: () => Effect.succeed({ reason: "ready" as const, autoBuilt: false }),
    status: () => Effect.succeed({ reason: "ready" as const, autoBuilt: false }),
  }),
)

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
  // Real analyzer (repo only) and real intelligence (repo + git) over the
  // same tmpdir-backed repo the test body seeds.
  const memoryRepoLayer = Banyan.memoryRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const memoryServiceLayer = Banyan.memoryServiceLayer.pipe(
    Layer.provide(memoryRepoLayer as Layer.Layer<never, never, never>),
    Layer.provide(dbLayer),
  )
  const memoryProjectionLayer = Banyan.memoryProjectionLayer.pipe(
    Layer.provide(memoryRepoLayer as Layer.Layer<never, never, never>),
    Layer.provide(dbLayer),
  )
  // Merge repo + service + projection so handlers reading any of them get
  // the same DB (mirrors memory-http.test.ts; separate provides hang).
  const memoryLayerFinal = Layer.merge(Layer.merge(memoryRepoLayer, memoryServiceLayer), memoryProjectionLayer)
  const analyzerLayer = Banyan.codegraphAnalyzerLayer.pipe(Layer.provide(codegraphRepoLayer))
  const intelLayer = Banyan.repositoryIntelligenceLayer.pipe(
    Layer.provide(codegraphRepoLayer),
    Layer.provide(Banyan.gitDefaultLayer),
  )

  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, repositoryIntelHandlers, memoryHandlers]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      Layer.provide(meshLayer),
      Layer.provide(busLayer),
      Layer.provide(plansLayer),
      Layer.provide(codegraphRepoLayer),
      Layer.provide(memoryLayerFinal),
      Layer.provide(analyzerLayer),
      Layer.provide(intelLayer),
      Layer.provide(allowPermissionLayer),
      Layer.provide(readyReadinessLayer),
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
  )
}

type McpTextResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

const toolText = (result: unknown): string => {
  const r = result as McpTextResult
  expect(Array.isArray(r.content)).toBe(true)
  expect(r.content[0]?.type).toBe("text")
  return r.content[0]?.text ?? ""
}

const toolJson = <T>(result: unknown): T => JSON.parse(toolText(result)) as T

const isToolError = (result: unknown): boolean => (result as McpTextResult).isError === true

// One connected protocol pair per live test: real McpServer with the code
// tools registered (backed by the real in-process HTTP server via the typed
// SDK client) plus a real MCP Client on the other end of the linked
// InMemoryTransport pair.
const withProtocol = <A>(
  cwd: string,
  seedCount: number,
  body: (client: Client) => Promise<A>,
): Effect.Effect<A, unknown, unknown> =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const baseUrl = HttpServer.formatAddress(server.address)
    const sdk = createOpencodeClient({ baseUrl })
    const repo = yield* Banyan.CodegraphRepo
    yield* repo.putFile(FIXTURE_FILE)
    for (let n = 0; n < seedCount; n++) {
      yield* repo.putNode(fixtureNode(n))
    }
    yield* repo.setMeta({ ...FIXTURE_META, totalNodes: seedCount })

    const mcp = new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
    registerCodeTools(mcp, { sdk, cwd })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "tools-code-test-client", version: "0.0.0-test" })
    // Server first: client.connect sends `initialize` and waits for the
    // response, so connecting the client before the server deadlocks (the
    // server side would never get to drain the queued message).
    yield* Effect.promise(() => mcp.connect(serverTransport))
    yield* Effect.promise(() => client.connect(clientTransport))
    try {
      return yield* Effect.promise(() => body(client))
    } finally {
      yield* Effect.promise(() => client.close().catch(() => {}))
      yield* Effect.promise(() => mcp.close().catch(() => {}))
    }
  })

const runWithFreshDb = <A>(body: (cwd: string) => Effect.Effect<A, unknown, unknown>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.promise(() => tmpdir())
    try {
      const dbPath = path.join(tmp.path, "mcp-tools-code.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)
      const repoLayer = Banyan.codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
      const apiLayer = buildApiLayer(dbPath, repoLayer)
      yield* Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
      }).pipe(Effect.provide(dbLayer), Effect.scoped)
      return yield* body(tmp.path).pipe(Effect.scoped, Effect.provide(apiLayer), Effect.provide(repoLayer))
    } finally {
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }
  })

describe("mcp code tools (Phase 0 slice)", () => {
  test("op guards accept exactly the documented ops", () => {
    for (const op of ["query", "explain", "impact", "trace", "tests", "symbols", "relationships", "ownership", "slice"]) {
      expect(isRepoOp(op)).toBe(true)
    }
    expect(isRepoOp("forget")).toBe(false)
    expect(isChangeCheckOp("preflight")).toBe(true)
    expect(isChangeCheckOp("blast_radius")).toBe(true)
    expect(isChangeCheckOp("rename")).toBe(false)
    expect(isCodegraphOp("status")).toBe(true)
    expect(isCodegraphOp("build")).toBe(true)
    expect(isCodegraphOp("remove")).toBe(false)
  })

  test("route resolvers map every op onto its existing HTTP route", () => {
    expect(resolveRepoRoute("query")).toBe("/global/repository/query")
    expect(resolveRepoRoute("explain")).toBe("/global/repository/explain")
    expect(resolveRepoRoute("impact")).toBe("/global/repository/impact")
    expect(resolveRepoRoute("trace")).toBe("/global/repository/trace")
    expect(resolveRepoRoute("tests")).toBe("/global/repository/tests")
    expect(resolveRepoRoute("symbols")).toBe("/global/repository/symbols")
    expect(resolveRepoRoute("relationships")).toBe("/global/repository/relationships")
    expect(resolveRepoRoute("ownership")).toBe("/global/repository/ownership")
    expect(resolveRepoRoute("slice")).toBe("/global/repository/architectural-slice")
    expect(resolveChangeCheckRoute("preflight")).toBe("/global/preflight")
    expect(resolveChangeCheckRoute("blast_radius")).toBe("/global/blast-radius")
    expect(resolveCodegraphRoute("status")).toBe("/global/codegraph-status")
    expect(resolveCodegraphRoute("build")).toBe("/global/codegraph-build")
  })

  test("path guard keeps in-root paths, rejects .. and absolute escapes", () => {
    expect(isInsideRoot("/repo", "src/a.ts")).toBe(true)
    expect(isInsideRoot("/repo", "src/../src/a.ts")).toBe(true)
    expect(isInsideRoot("/repo", "../escape.ts")).toBe(false)
    expect(isInsideRoot("/repo", "/etc/passwd")).toBe(false)
    expect(isInsideRoot("/repo", "a/../../escape.ts")).toBe(false)
  })

  test("output cap truncates with a marker, passes small text through", () => {
    const small = capOutput("hello")
    expect(small).toEqual({ text: "hello", truncated: false })
    const big = capOutput("x".repeat(CODE_TOOL_OUTPUT_MAX_CHARS + 100))
    expect(big.truncated).toBe(true)
    expect(big.text.length).toBeLessThanOrEqual(CODE_TOOL_OUTPUT_MAX_CHARS)
    expect(big.text.endsWith(OUTPUT_TRUNCATED_MARKER)).toBe(true)
  })

  const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

  it.live("protocol: lists the four banyan_ tools with op-merged schemas", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, 1, async (client) => {
          const { tools } = await client.listTools()
          expect(tools.map((t) => t.name).sort()).toEqual([...CodeToolNames].sort())
          for (const tool of tools) {
            expect(tool.description).toContain("untrusted")
          }
          const byName = new Map(tools.map((t) => [t.name, t]))
          // zod-to-json-schema shape varies by converter (anyOf/const vs
          // enum), so accept either when reading the closed value sets.
          const literalsOf = (schema: {
            anyOf?: Array<{ const?: string }>
            enum?: string[]
          }): Array<string | undefined> =>
            schema.anyOf !== undefined ? schema.anyOf.map((e) => e.const) : (schema.enum ?? [])
          const shapeOf = (name: string) =>
            (byName.get(name)?.inputSchema ?? {}) as {
              type?: string
              properties?: Record<string, { anyOf?: Array<{ const?: string }>; enum?: string[] }>
              required?: string[]
            }
          // code_find carries the intent literals; the merged tools carry op.
          const codeFindLiterals = literalsOf(shapeOf("banyan_code_find").properties?.["intent"] ?? {})
          expect(codeFindLiterals.sort()).toEqual(["callers", "definition", "dependents", "find_file", "impact"])
          for (const name of ["banyan_repo", "banyan_change_check", "banyan_codegraph"]) {
            const opLiterals = literalsOf(shapeOf(name).properties?.["op"] ?? {})
            expect(opLiterals.length).toBeGreaterThan(1)
          }
          const repoOps = literalsOf(shapeOf("banyan_repo").properties?.["op"] ?? {})
          expect(repoOps.sort()).toEqual(
            ["query", "explain", "impact", "trace", "tests", "symbols", "relationships", "ownership", "slice"].sort(),
          )
          // Closed value sets are enforced at the protocol boundary: an
          // unknown op never reaches a handler. The server surfaces the
          // validation failure as a tool error result (or a JSON-RPC
          // error, which the client surfaces as a throw); either way the
          // op is rejected without handler execution.
          const invalid = await client
            .callTool({ name: "banyan_repo", arguments: { op: "forget", query: "x" } })
            .then((result) => (isToolError(result) ? ("rejected" as const) : ("accepted" as const)))
            .catch(() => "rejected" as const)
          expect(invalid).toBe("rejected")
        }),
      )
    }),
  )

  it.live("protocol: code_find + change_check round-trip against the real index", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, 1, async (client) => {
          const found = await client.callTool({
            name: "banyan_code_find",
            arguments: { intent: "definition", target: "MyWidget", includeKeywordFallback: true },
          })
          expect(isToolError(found)).toBe(false)
          const matches = toolJson<{ matches: Array<{ node: { id: string } }>; resolvedNodeID?: string }>(found)
          expect(matches.matches[0]?.node.id).toBe("n-widget-0")
          expect(matches.resolvedNodeID).toBe("n-widget-0")

          const preflight = await client.callTool({
            name: "banyan_change_check",
            arguments: { op: "preflight", target: "MyWidget", action: "modify", depth: 2 },
          })
          expect(isToolError(preflight)).toBe(false)
          const report = toolJson<{ target: { resolved: boolean }; directCallers: unknown[]; risks: unknown[] }>(
            preflight,
          )
          expect(report.target.resolved).toBe(true)
          expect(Array.isArray(report.directCallers)).toBe(true)
          expect(Array.isArray(report.risks)).toBe(true)

          const blast = await client.callTool({
            name: "banyan_change_check",
            arguments: { op: "blast_radius", target: "MyWidget" },
          })
          expect(isToolError(blast)).toBe(false)
          const counts = toolJson<{ directCallers: number; risk: string; resolved: boolean }>(blast)
          expect(typeof counts.directCallers).toBe("number")
          expect(typeof counts.risk).toBe("string")
          expect(counts.resolved).toBe(true)
        }),
      )
    }),
  )

  it.live("protocol: all nine repo ops round-trip against the real index", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, 1, async (client) => {
          const query = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "query", query: "MyWidget" },
          })
          expect(isToolError(query)).toBe(false)
          const queryBody = toolJson<{ slice: { summary: string }; context: { query: string } }>(query)
          expect(typeof queryBody.slice.summary).toBe("string")
          expect(queryBody.context.query).toBe("MyWidget")

          const explain = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "explain", symbol: "MyWidget" },
          })
          expect(isToolError(explain)).toBe(false)
          expect(typeof toolJson<{ summary: string }>(explain).summary).toBe("string")

          const impact = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "impact", path: "src/widget.ts" },
          })
          expect(isToolError(impact)).toBe(false)
          expect(typeof toolJson<{ summary: string }>(impact).summary).toBe("string")

          const trace = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "trace", symbol: "MyWidget", depth: 2 },
          })
          expect(isToolError(trace)).toBe(false)
          expect(typeof toolJson<{ summary: string }>(trace).summary).toBe("string")

          const tests = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "tests", symbol: "MyWidget" },
          })
          expect(isToolError(tests)).toBe(false)
          expect(Array.isArray(toolJson<unknown[]>(tests))).toBe(true)

          const symbols = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "symbols", query: "MyWidget" },
          })
          expect(isToolError(symbols)).toBe(false)
          const symbolNodes = toolJson<Array<{ id: string }>>(symbols)
          expect(symbolNodes.some((n) => n.id === "n-widget-0")).toBe(true)

          const relationships = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "relationships", nodeID: "n-widget-0", depth: 1 },
          })
          expect(isToolError(relationships)).toBe(false)
          expect(Array.isArray(toolJson<unknown[]>(relationships))).toBe(true)

          const ownership = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "ownership", path: "src/widget.ts" },
          })
          expect(isToolError(ownership)).toBe(false)
          expect(typeof toolJson<{ count: number }>(ownership).count).toBe("number")

          const slice = await client.callTool({
            name: "banyan_repo",
            arguments: { op: "slice", focus: "MyWidget" },
          })
          expect(isToolError(slice)).toBe(false)
          expect(typeof toolJson<{ summary: string }>(slice).summary).toBe("string")

          const missingArg = await client.callTool({ name: "banyan_repo", arguments: { op: "query" } })
          expect(isToolError(missingArg)).toBe(true)
          expect(toolText(missingArg)).toContain('requires "query"')
        }),
      )
    }),
  )

  it.live("protocol: codegraph status/build, traversal rejections, output cap", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, 120, async (client) => {
          const status = await client.callTool({ name: "banyan_codegraph", arguments: { op: "status", root: cwd } })
          expect(isToolError(status)).toBe(false)
          const statusBody = toolJson<{ reason: string }>(status)
          expect(["ready", "missing", "stale", "building", "failed"]).toContain(statusBody.reason)

          const build = await client.callTool({
            name: "banyan_codegraph",
            arguments: { op: "build", root: cwd },
          })
          expect(isToolError(build)).toBe(false)
          const buildBody = toolJson<{ started: boolean; dbPath?: string }>(build)
          expect(buildBody.started).toBe(true)
          expect(buildBody.dbPath).toContain("banyancode-")

          const traversals: Array<{ name: string; arguments: Record<string, unknown> }> = [
            { name: "banyan_repo", arguments: { op: "impact", path: "../escape.ts" } },
            { name: "banyan_repo", arguments: { op: "ownership", path: "/etc/passwd" } },
            { name: "banyan_repo", arguments: { op: "relationships", path: "a/../../escape.ts" } },
            { name: "banyan_codegraph", arguments: { op: "status", root: "../escape" } },
          ]
          for (const call of traversals) {
            const rejected = await client.callTool(call)
            expect(isToolError(rejected)).toBe(true)
            expect(toolText(rejected)).toContain("escapes")
          }

          const capped = await client.callTool({
            name: "banyan_code_find",
            arguments: { intent: "definition", target: "MyWidget", includeKeywordFallback: true, limit: 200 },
          })
          expect(isToolError(capped)).toBe(false)
          const text = toolText(capped)
          expect(text.length).toBeLessThanOrEqual(CODE_TOOL_OUTPUT_MAX_CHARS + OUTPUT_TRUNCATED_MARKER.length)
          expect(text.endsWith(OUTPUT_TRUNCATED_MARKER)).toBe(true)
        }),
      )
    }),
  )
})
