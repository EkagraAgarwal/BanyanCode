// MCP verify + memory tools: unit + protocol tests (gap-plan Milestone C3 + C4).
//
// Real McpServer + real MCP Client over an InMemoryTransport linked pair,
// handlers calling the real in-process HTTP routes via the typed SDK v2
// client, backed by a real tmpdir database. The verify tests run against a
// real tmp target repo with a failing bun test (no mocks). Layer recipe
// mirrors tools-code.test.ts, plus the verifier chain (VerificationRepo +
// AppProcess + BanyanConfigService) that the typecheck/test-run/lint
// handlers need at request time.

import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import { Client } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { MCP_ERAS, withEraClient } from "./era-harness"
import type { McpEra } from "./era-harness"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Banyan } from "@opencode-ai/core/banyancode"
import { AppProcess } from "@opencode-ai/core/process"
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
import { mkdir } from "node:fs/promises"
import {
  VerifyMemoryToolNames,
  buildMemoryStorePayload,
  readPackageScripts,
  registerVerifyMemoryTools,
  resolveMemoryScope,
  resolveVerifyRoot,
  selectVerifyCommand,
} from "../../src/mcp-server/tools-verify-memory"

describe("mcp verify/memory command selection + scope + payload (pure)", () => {
  test("selectVerifyCommand prefers project scripts, falls back otherwise", () => {
    expect(selectVerifyCommand("typecheck", { scripts: { typecheck: "tsgo --noEmit" } })).toEqual({
      command: "bun run typecheck",
      via: "script",
      available: true,
    })
    const typecheckFallback = selectVerifyCommand("typecheck", { scripts: {} })
    expect(typecheckFallback.command).toBe("bunx tsc --noEmit")
    expect(typecheckFallback.via).toBe("fallback")
    expect(typecheckFallback.available).toBe(true)
    expect(typecheckFallback.note).toContain("typecheck")

    const testScript = selectVerifyCommand("test", { scripts: { test: "bun test" }, testPath: "a.test.ts" })
    expect(testScript.command).toBe("bun test a.test.ts")
    expect(testScript.via).toBe("script")
    const testFallback = selectVerifyCommand("test", { scripts: {}, testPath: "a.test.ts" })
    expect(testFallback).toEqual({ command: "bun test a.test.ts", via: "fallback", available: true })
    expect(selectVerifyCommand("test", { testPath: "a.test.ts", framework: "vitest" }).command).toBe(
      "bunx vitest a.test.ts",
    )

    expect(selectVerifyCommand("lint", { scripts: { lint: "eslint ." } })).toEqual({
      command: "bun run lint",
      via: "script",
      available: true,
    })
    const lintFallback = selectVerifyCommand("lint", { scripts: {} })
    expect(lintFallback.command).toBe("bun run lint")
    expect(lintFallback.via).toBe("fallback")
    expect(lintFallback.available).toBe(false)
    expect(lintFallback.note).toContain("lint")
  })

  test("resolveMemoryScope defaults to global; session needs a sessionID", () => {
    expect(resolveMemoryScope(undefined, undefined)).toEqual({ scope: "global" })
    expect(resolveMemoryScope("global", undefined)).toEqual({ scope: "global" })
    expect(resolveMemoryScope("session", "ses_123")).toEqual({ scope: "session", sessionID: "ses_123" })
    expect(resolveMemoryScope("session", undefined)).toEqual({
      error: `memory scope "session" requires "sessionID"`,
    })
    const bad = resolveMemoryScope("forget", undefined)
    expect("error" in bad && bad.error).toContain("global")
  })

  test("buildMemoryStorePayload keeps the origin:mcp tag but drops the origin field", () => {
    const payload = buildMemoryStorePayload({ key: "mcp:probe", value: { a: 1 }, scope: "global", tags: ["t"] })
    expect(payload["key"]).toBe("mcp:probe")
    expect(payload["scope"]).toBe("global")
    expect(payload["tags"]).toContain("origin:mcp")
    expect(payload["tags"]).toContain("t")
    expect("origin" in payload).toBe(false)
    const minimal = buildMemoryStorePayload({ key: "mcp:probe", value: "v", scope: "global" })
    expect(minimal["tags"]).toEqual(["origin:mcp"])
  })

  test("readPackageScripts reads scripts, tolerates missing/invalid package.json", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    const found = await readPackageScripts(tmp.path)
    expect(found.scripts["test"]).toBe("bun test")
    const missing = await readPackageScripts(path.join(tmp.path, "nope"))
    expect(missing.scripts).toEqual({})
    await Bun.write(path.join(tmp.path, "bad.json"), "{oops")
    const invalid = await readPackageScripts(tmp.path)
    expect(invalid.scripts["test"]).toBe("bun test")
  })

  test("resolveVerifyRoot: relative stays in cwd, absolute dirs allowed, missing rejected", async () => {
    await using tmp = await tmpdir()
    const inside = await resolveVerifyRoot(tmp.path, "sub/dir")
    expect("root" in inside && (inside.root as string).endsWith(path.join("sub", "dir"))).toBe(true)
    const escape = await resolveVerifyRoot(tmp.path, "../escape")
    expect("error" in escape).toBe(true)
    const absolute = await resolveVerifyRoot("/other", tmp.path)
    expect(absolute).toEqual({ root: path.resolve(tmp.path) })
    const missing = await resolveVerifyRoot(tmp.path, path.join(tmp.path, "nope"))
    expect("error" in missing).toBe(true)
    const file = path.join(tmp.path, "f.txt")
    await Bun.write(file, "x")
    const notDir = await resolveVerifyRoot(tmp.path, file)
    expect("error" in notDir).toBe(true)
  })
})

// Headless allow-all permission (same shape as tools-code.test.ts).
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

// Headless ready readiness: verify/memory never touch the codegraph, and a
// real ensureReady would kick off an index build against process.cwd().
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
  const memoryRepoLayer = Banyan.memoryRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const memoryServiceLayer = Banyan.memoryServiceLayer.pipe(
    Layer.provide(memoryRepoLayer as Layer.Layer<never, never, never>),
    Layer.provide(dbLayer),
  )
  const memoryProjectionLayer = Banyan.memoryProjectionLayer.pipe(
    Layer.provide(memoryRepoLayer as Layer.Layer<never, never, never>),
    Layer.provide(dbLayer),
  )
  const memoryLayerFinal = Layer.merge(Layer.merge(memoryRepoLayer, memoryServiceLayer), memoryProjectionLayer)
  const analyzerLayer = Banyan.codegraphAnalyzerLayer.pipe(Layer.provide(codegraphRepoLayer))
  const intelLayer = Banyan.repositoryIntelligenceLayer.pipe(
    Layer.provide(codegraphRepoLayer),
    Layer.provide(Banyan.gitDefaultLayer),
  )
  // Verifier chain for the typecheck/test-run/lint handlers: tmpdir-scoped
  // repo so runs persist to the test DB, real process spawner, real
  // (read-only here) BanyanConfig.
  const verificationRepoLayer = Banyan.verificationRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const verifierLayer = Banyan.verifierServiceLayer.pipe(
    Layer.provide(verificationRepoLayer as Layer.Layer<never, never, never>),
    Layer.provide(AppProcess.defaultLayer),
    Layer.provide(Banyan.banyanConfigServiceDefaultLayer),
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
      Layer.provide(verifierLayer),
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

const withProtocol = (
  cwd: string,
  body: (era: McpEra, client: Client) => Promise<unknown>,
): Effect.Effect<void, unknown, unknown> =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const baseUrl = HttpServer.formatAddress(server.address)
    const sdk = createOpencodeClient({ baseUrl })

    const buildServer = () => {
      const mcp = new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
      registerVerifyMemoryTools(mcp, { sdk, cwd })
      return mcp
    }
    // Dual-era (gap-plan D0): legacy `initialize` + modern
    // `server/discover` with per-request `_meta`. The era is threaded into
    // the body so stateful cases (memory store) can key per era — the
    // memory store is shared across both legs of one test. Failures are
    // tagged with the era that failed.
    for (const era of MCP_ERAS) {
      yield* Effect.promise(() =>
        withEraClient(era, buildServer, { name: "verify-memory-test-client", version: "0.0.0-test" }, (client) =>
          body(era, client),
        ),
      )
    }
  })

const runWithFreshDb = <A>(body: (cwd: string) => Effect.Effect<A, unknown, unknown>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.promise(() => tmpdir())
    try {
      const dbPath = path.join(tmp.path, "mcp-verify-memory.sqlite")
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

// Target repo for banyan_verify: one passing + one failing bun test, plus a
// package.json so command selection takes the script path.
const seedTargetRepo = async (dir: string): Promise<{ failing: string }> => {
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "mcp-verify-target", scripts: { test: "bun test", typecheck: "bunx tsc --noEmit" } }),
  )
  const failing = "probe-failing.test.ts"
  await Bun.write(
    path.join(dir, failing),
    `import { test, expect } from "bun:test"\ntest("mcp probe fails", () => { expect(1).toBe(2) })\ntest("mcp probe passes", () => { expect(1).toBe(1) })\n`,
  )
  return { failing }
}

describe("mcp verify + memory tools (C3 + C4)", () => {
  const it = testEffect(Layer.succeedContext(Context.empty() as Context.Context<unknown>))

  it.live("protocol: lists banyan_memory + banyan_verify with titles, annotations, outputSchema, _meta", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, async (_era, client) => {
          const { tools } = await client.listTools()
          expect(tools.map((t) => t.name).sort()).toEqual([...VerifyMemoryToolNames].sort())
          expect(tools.map((t) => t.name)).toEqual([...tools.map((t) => t.name)].sort())
          for (const tool of tools) {
            expect(typeof tool.title).toBe("string")
            expect(tool.title?.length).toBeGreaterThan(0)
            expect(tool.annotations?.readOnlyHint).toBe(false)
            expect(tool.annotations?.openWorldHint).toBe(false)
            expect(tool.annotations?.destructiveHint).toBe(false)
            expect(tool.outputSchema).toBeDefined()
            expect(tool.outputSchema?.type).toBe("object")
            const meta = tool._meta as Record<string, unknown> | undefined
            expect(typeof meta?.["anthropic/maxResultSizeChars"]).toBe("number")
          }
          const byName = new Map(tools.map((t) => [t.name, t]))
          const verifyShape = (byName.get("banyan_verify")?.inputSchema ?? {}) as {
            properties?: Record<string, unknown>
          }
          expect(Object.keys(verifyShape.properties ?? {}).sort()).toEqual(
            ["directory", "framework", "kind", "max_failures", "path"].sort(),
          )
        }),
      )
    }),
  )

  it.live("protocol: banyan_verify test kind returns counts + first-N failures for a failing repo", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, async (_era, client) => {
          const target = path.join(cwd, "target-repo")
          await mkdir(target, { recursive: true })
          const { failing } = await seedTargetRepo(target)

          const full = await client.callTool({
            name: "banyan_verify",
            arguments: { kind: "test", path: failing, directory: target },
          })
          expect(isToolError(full)).toBe(false)
          const body = toolJson<{
            kind: string
            status: string
            passed: number
            failed: number
            failures: string[]
            projectRoot: string
            command: string
            commandVia: string
          }>(full)
          expect(body.kind).toBe("test")
          expect(body.status).toBe("failed")
          expect(body.passed).toBe(1)
          expect(body.failed).toBe(1)
          expect(body.failures.length).toBeGreaterThan(0)
          expect(body.failures.length).toBeLessThanOrEqual(10)
          expect(body.projectRoot).toBe(path.resolve(target))
          expect(body.command).toContain("bun test")
          expect(body.commandVia).toBe("script")

          const one = await client.callTool({
            name: "banyan_verify",
            arguments: { kind: "test", path: failing, directory: target, max_failures: 1 },
          })
          expect(isToolError(one)).toBe(false)
          expect(toolJson<{ failures: string[] }>(one).failures).toHaveLength(1)

          // Minimal args: directory defaults to the server cwd. A missing
          // path for kind test is a caller-correctable argument error.
          const missingPath = await client.callTool({ name: "banyan_verify", arguments: { kind: "test" } })
          expect(isToolError(missingPath)).toBe(true)
          expect(toolText(missingPath)).toContain("INVALID_ARGUMENTS")

          // Traversal escapes the project root instead of running.
          const escape = await client.callTool({
            name: "banyan_verify",
            arguments: { kind: "test", path: "../escape.test.ts", directory: target },
          })
          expect(isToolError(escape)).toBe(true)
          expect(toolText(escape)).toContain("PATH_ESCAPE")
        }),
      )
    }),
  )

  it.live("protocol: banyan_verify lint kind returns a well-formed summary on a scriptless repo", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, async (_era, client) => {
          const target = path.join(cwd, "lint-repo")
          await mkdir(target, { recursive: true })
          await Bun.write(path.join(target, "package.json"), JSON.stringify({ name: "lint-target" }))
          const result = await client.callTool({
            name: "banyan_verify",
            arguments: { kind: "lint", directory: target },
          })
          expect(isToolError(result)).toBe(false)
          const body = toolJson<{
            kind: string
            status: string
            command: string
            commandAvailable: boolean
            durationMs: number
          }>(result)
          expect(body.kind).toBe("lint")
          expect(["passed", "failed", "errored"]).toContain(body.status)
          expect(body.command).toBe("bun run lint")
          expect(body.commandAvailable).toBe(false)
          expect(typeof body.durationMs).toBe("number")
        }),
      )
    }),
  )

  it.live("protocol: banyan_memory store/recall/get/search/summary round-trip with origin:mcp", () =>
    Effect.gen(function* () {
      yield* runWithFreshDb((cwd) =>
        withProtocol(cwd, async (era, client) => {
          // Era-unique key: the memory store is shared across both legs of
          // this test, so each era stores under its own key and recall
          // still returns exactly the entry it stored.
          const key = `mcp:verify-probe-${era}`
          const stored = await client.callTool({
            name: "banyan_memory",
            arguments: { op: "store", key, value: { fact: "probe marker seven" }, tags: ["probe"] },
          })
          expect(isToolError(stored)).toBe(false)
          const storedBody = toolJson<{ id: string; version: number }>(stored)
          expect(typeof storedBody.id).toBe("string")

          const recalled = await client.callTool({ name: "banyan_memory", arguments: { op: "recall", key } })
          expect(isToolError(recalled)).toBe(false)
          const entries = toolJson<Array<{ id: string; key: string; tags: string[] }>>(recalled)
          expect(entries).toHaveLength(1)
          expect(entries[0]?.id).toBe(storedBody.id)
          expect(entries[0]?.tags).toContain("origin:mcp")
          expect(entries[0]?.tags).toContain("probe")

          const got = await client.callTool({ name: "banyan_memory", arguments: { op: "get", id: storedBody.id } })
          expect(isToolError(got)).toBe(false)
          expect(toolJson<{ key: string }>(got).key).toBe(key)

          const searched = await client.callTool({
            name: "banyan_memory",
            arguments: { op: "search", query: "marker seven" },
          })
          expect(isToolError(searched)).toBe(false)
          const searchBody = toolJson<{ entries: Array<{ id: string }>; totalHits: number }>(searched)
          expect(searchBody.totalHits).toBeGreaterThanOrEqual(1)
          expect(searchBody.entries.some((e) => e.id === storedBody.id)).toBe(true)

          const summary = await client.callTool({ name: "banyan_memory", arguments: { op: "summary" } })
          expect(isToolError(summary)).toBe(false)
          expect(toolJson<{ totalActive: number }>(summary).totalActive).toBeGreaterThanOrEqual(1)

          // Validation failures are tool errors the model can self-correct.
          const missingKey = await client.callTool({ name: "banyan_memory", arguments: { op: "recall" } })
          expect(isToolError(missingKey)).toBe(true)
          expect(toolText(missingKey)).toContain("INVALID_ARGUMENTS")

          const noSession = await client.callTool({
            name: "banyan_memory",
            arguments: { op: "recall", key, scope: "session" },
          })
          expect(isToolError(noSession)).toBe(true)
          expect(toolText(noSession)).toContain("sessionID")

          const oversize = await client.callTool({
            name: "banyan_memory",
            arguments: { op: "store", key, value: "x".repeat(40_000) },
          })
          expect(isToolError(oversize)).toBe(true)
          expect(toolText(oversize)).toContain("INVALID_ARGUMENTS")

          const badOp = await client
            .callTool({ name: "banyan_memory", arguments: { op: "forget", key } })
            .then((result) => result)
            .catch(() => "rejected" as const)
          expect(badOp === "rejected" || isToolError(badOp)).toBe(true)
        }),
      )
    }),
  )
})
