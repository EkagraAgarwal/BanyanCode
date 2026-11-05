/**
 * The repository gateway through the real execution path.
 *
 *   Tool.Service.snapshot(permissions).execute({ call, definitions })
 *     → `execute.before` hooks (the real `Gateway.register` mounted by `src/server.ts`)
 *     → the resolved tool's real `execute`
 *     → `execute.after` hooks
 *
 * The leaves are the real core `read` / `grep` / `glob` / `edit` plugins, the
 * rewrite targets are the real banyancode `Tool.Info` values `src/intel/tools.ts`
 * registers, the probe is the real `integration/gateway-probe.ts`, and the graph
 * is a real index of fixture files into a throwaway SQLite database. Nothing in
 * this file mocks the gateway.
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { BanyanConfig } from "../../src/config/index.js"
import { Storage } from "../../src/storage/index.js"
import { make as makeRepo } from "../../src/codegraph/codegraph-repo.js"
import { make as makeIndexer } from "../../src/codegraph/codegraph-indexer.js"
import { make as makeBuildService } from "../../src/codegraph/codegraph-build-service.js"
import { make as makeReadiness } from "../../src/codegraph/codegraph-readiness.js"
import { makeService as makeSearchService } from "../../src/codegraph/search/search.js"
import { make as makeStructural } from "../../src/codegraph/structural-queries/structural-queries.js"
import { tool as codegraphTool } from "../../src/codegraph/tools/codegraph.js"
import { make as makeCodegraphPort } from "../../src/integration/codegraph-port.js"
import { make as makeGatewayProbe } from "../../src/integration/gateway-probe.js"
import { make as makeRepositoryIntelligence } from "../../src/intel/service.js"
import { buildTools as buildIntelTools } from "../../src/intel/tools.js"
import { register as registerGateway } from "../../src/gateway/index.js"
import { listGatewayUsage, listToolUsage, recordToolUsage } from "../../src/telemetry/usage.js"

// The core host is imported dynamically: `@banyancode/plugin` must not depend on
// `@opencode/core` in production (core depends on this plugin).
const core = (path: string) => import(["..", "..", "..", "core", path].join("/"))
const { AppNodeBuilder } = await core("src/effect/app-node-builder.js")
const { Tool } = await core("src/tool.js")
const { PluginHooks } = await core("src/plugin/hooks.js")
const { Environment } = await core("src/environment/index.js")
const { Ripgrep } = await core("src/ripgrep.js")
const { FileAccess } = await core("src/file-access.js")
const { FileMutation } = await core("src/file-mutation.js")
const { Formatter } = await core("src/formatter.js")
const { ReadToolFileSystem } = await core("src/tool/read-filesystem.js")
const { Location } = await core("src/location.js")
const { Permission } = await core("src/permission.js")
const { SessionInstructions } = await core("src/session/instructions.js")
const { ReadTool } = await core("src/tool/plugin/read.js")
const { GrepTool } = await core("src/tool/plugin/grep.js")
const { GlobTool } = await core("src/tool/plugin/glob.js")
const { EditTool } = await core("src/tool/plugin/edit.js")
const { Session } = await core("src/session.js")
const { SessionMessage } = await core("src/session/message.js")
const { Agent } = await core("src/agent.js")
const { AbsolutePath } = await core("src/schema.js")
const { location: fixtureLocation } = await core("test/fixture/location.js")
const { permissionLayer } = await core("test/lib/permission.js")
const { registerToolPlugin } = await core("test/lib/tool.js")
const { host } = await core("test/plugin/host.js")

// This file owns the env: router selection consults BANYANCODE_ROUTER before config.
process.env.BANYANCODE_ENABLE = "1"
delete process.env.BANYANCODE_ROUTER
delete process.env.BANYANCODE_ROUTER_TRACE

// --- Fixture files -----------------------------------------------------------

/** Eight functions with bodies: long on disk, short in an outline. */
const LARGE_SRC = `${Array.from({ length: 8 }, (_, index) =>
  [
    `export function large${index}() {`,
    ...Array.from({ length: 8 }, (_, line) => `  const v${line} = ${index * 10 + line}`),
    "  return v0",
    "}",
  ].join("\n"),
).join("\n\n")}\n`
const AUTH_SRC = ["export class AuthManager {", "  constructor() {}", "  login() { return true }", "}", ""].join("\n")
const SERVER_SRC = [
  'import { AuthManager } from "./auth"',
  "",
  "export function handleRequest() {",
  "  const manager = new AuthManager()",
  "  return manager.login()",
  "}",
  "",
].join("\n")
const README_SRC = ["# Fixture Docs", "", "The authentication flow is documented here.", ""].join("\n")

const FIXTURE_FILES = [
  ["src/auth.ts", AUTH_SRC],
  ["src/server.ts", SERVER_SRC],
  ["src/large.ts", LARGE_SRC],
  ["docs/README.md", README_SRC],
  ["package.json", '{\n  "name": "fixture"\n}\n'],
] as const

const sessionID = Session.ID.make("ses_gateway")
const identity = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_gateway"),
}

const toolCall = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool-call" as const,
  id,
  name,
  input,
})

type Outcome = { readonly status: "completed" | "error"; readonly [key: string]: unknown }
type CallInput = { readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
type Execution = { readonly tool: string; readonly input: unknown; readonly status: string }

interface Api {
  readonly execute: (input: CallInput) => Effect.Effect<Outcome>
  readonly executions: readonly Execution[]
  readonly storage: Storage.Interface
  readonly assertions: readonly Assertion[]
  readonly toolOptions: (name: string) => { readonly codemode?: boolean } | undefined
  readonly schemaOf: (name: string) => unknown
  readonly decode: (schema: unknown, input: unknown) => Effect.Effect<unknown, unknown>
}

/** One `Permission.assert` call, recorded so the external read can be checked. */
type Assertion = { readonly action: string; readonly resources: readonly string[] }

interface Scenario {
  readonly config?: Readonly<Record<string, unknown>>
  /** Skip the index so the graph has no meta row. */
  readonly index?: boolean
  readonly permissions?: Rules
  /** Where `repository_route` traces go (defaults to the fixture directory). */
  readonly traceDir?: string
}

/** The agent rule shape the core snapshot and the gateway both read. */
type Rules = ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" }>

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-gateway-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const writeFixture = async (directory: string) => {
  await Promise.all(
    FIXTURE_FILES.map(async ([rel, content]) => {
      const absolute = join(directory, rel)
      await mkdir(join(absolute, ".."), { recursive: true })
      await writeFile(absolute, content, "utf8")
    }),
  )
}

const writeConfig = (directory: string, values: Readonly<Record<string, unknown>>) =>
  writeFile(join(directory, "banyancode.json"), JSON.stringify(values), "utf8")

const traceLines = async (directory: string): Promise<Record<string, unknown>[]> => {
  const file = Bun.file(join(directory, ".banyancode", "trace", `${sessionID}.jsonl`))
  if (!(await file.exists())) return []
  return (await file.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const runtimeFor = (directory: string, assertions: Assertion[]) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Tool.node,
      PluginHooks.node,
      Environment.node,
      Ripgrep.node,
      FileAccess.node,
      FileMutation.node,
      Formatter.node,
      ReadToolFileSystem.node,
      Location.node,
      Permission.node,
      SessionInstructions.node,
      FSUtil.node,
    ]),
    [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(fixtureLocation(Location.Ref.make({ directory: AbsolutePath.make(directory) })))),
      ),
      Permission.node.replace(
        permissionLayer({
          allows: () => Effect.succeed(true),
          assert: (input: Assertion) => Effect.sync(() => assertions.push(input)),
        }),
      ),
      Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
      SessionInstructions.node.replace(
        Layer.succeed(SessionInstructions.Service, SessionInstructions.Service.of({ load: () => Effect.void })),
      ),
    ],
  )

const runScenario = (
  directory: string,
  scenario: Scenario,
  body: (api: Api) => Effect.Effect<void, unknown, never>,
): Promise<void> => {
  const assertions: Assertion[] = []
  const effect = Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      const storage = yield* Storage.open({ projectRoot: directory, env: {} })
      const repo = makeRepo(storage)

      // A real index of the fixture: files, nodes, edges and a stamped meta row.
      const indexer = yield* makeIndexer(repo, storage)
      if (scenario.index !== false) {
        const indexed = yield* indexer.index({ root: directory, force: true })
        yield* repo.bumpVersion({ eligibleFiles: indexed.eligibleFiles, indexedRoot: directory })
      }

      const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
      const readiness = yield* makeReadiness({ buildService, repo })
      const search = makeSearchService(repo)
      const structural = makeStructural(repo)
      const projectRoot = () => directory

      const toolHook = (name: string, callback: unknown) => hooks.register("tool", name, callback as never)
      const activeLocation = fixtureLocation(
        Location.Ref.make({ directory: AbsolutePath.make(scenario.traceDir ?? directory) }),
      )
      const permissions = scenario.permissions ?? []
      const ctx = host({
        location: activeLocation,
        agent: {
          get: (input: { readonly agentID: string }) =>
            Effect.succeed({
              location: activeLocation,
              data: { id: input.agentID, permissions },
            }),
          list: () => Effect.die("unused agent.list"),
          transform: () => Effect.die("unused agent.transform"),
          reload: Effect.void,
        } as never,
        tool: { transform: tools.transform, reload: tools.reload, list: tools.list, hook: toolHook },
        permission: {
          hook: () => Effect.succeed({ dispose: Effect.void }),
          list: () => Effect.succeed({ data: [] }),
          get: () => Effect.die("unused permission.get"),
          reply: () => Effect.die("unused permission.reply"),
          // The intel tools gate their own reads through the plugin permission seam.
          assert: () => Effect.void,
        } as never,
        session: { context: () => Effect.succeed([]) },
      })

      yield* registerToolPlugin(ReadTool.Plugin, { location: ctx.location }, toolHook)
      yield* registerToolPlugin(GrepTool.Plugin, { location: ctx.location }, toolHook)
      yield* registerToolPlugin(GlobTool.Plugin, { location: ctx.location }, toolHook)
      yield* registerToolPlugin(EditTool.Plugin, { location: ctx.location }, toolHook)

      const port = makeCodegraphPort(repo)
      const intel = makeRepositoryIntelligence(port, { cwd: directory })
      const autoUpdate = { state: () => Effect.succeed({ status: "idle" as const, pending: 0 }) }
      const registered = [
        codegraphTool({
          repo,
          buildService,
          readiness,
          autoUpdate: autoUpdate as never,
          projectRoot,
        }),
        ...buildIntelTools({ ctx: ctx as never, port, intel, graph: { search, structural } }),
      ]
      yield* tools.transform((editor: any) => {
        for (const tool of registered) editor.add(tool)
      })

      const availableTools: ReadonlySet<string> = new Set((yield* tools.list()).map((tool: any) => tool.id as string))
      const config = BanyanConfig.make({
        directory,
        projectRoot: directory,
        globalDir: join(directory, "global-config"),
        home: directory,
        env: {},
      })
      yield* registerGateway(ctx, {
        storage,
        config,
        codegraph: makeGatewayProbe(repo, { storage }),
        availableTools,
      })

      // The telemetry workstream's recorder, mounted on the same hook so the
      // per-session tool rows are real.
      yield* hooks.register("tool", "execute.after", (event: { tool: string; sessionID: string; status: string }) =>
        event.status === "completed"
          ? recordToolUsage(storage, event.tool, event.sessionID)
          : Effect.void,
      )

      const executions: Execution[] = []
      yield* hooks.register("tool", "execute.after", (event: { tool: string; input: unknown; status: string }) =>
        Effect.sync(() => {
          executions.push({ tool: event.tool, input: event.input, status: event.status })
        }),
      )

      const execute = (input: CallInput): Effect.Effect<Outcome> =>
        Effect.gen(function* () {
          const snapshot: any = yield* tools.snapshot(scenario.permissions)
          const definitions = new Map(snapshot.definitions.map((tool: any) => [tool.name, tool] as const))
          const exit = yield* snapshot
            .execute({ ...identity, definitions, call: toolCall(input.id, input.name, input.input) })
            .pipe(Effect.exit)
          if (Exit.isSuccess(exit)) return { status: "completed" as const, ...(exit.value as object) }
          return { status: "error" as const, error: Option.getOrUndefined(Exit.findErrorOption(exit)) }
        }) as unknown as Effect.Effect<Outcome>

      const listed: ReadonlyArray<{
        readonly id: string
        readonly name?: string
        readonly options?: { codemode?: boolean }
        readonly input?: unknown
      }> = yield* tools.list()

      yield* body({
        execute,
        executions,
        storage,
        assertions,
        toolOptions: (name) => listed.find((tool) => (tool.name ?? tool.id) === name)?.options,
        schemaOf: (name) => listed.find((tool) => (tool.name ?? tool.id) === name)?.input,
        decode: (schema, input) => Schema.decodeUnknownEffect(schema as never)(input).pipe(Effect.orDie),
      })
    }).pipe(Effect.provide(runtimeFor(directory, assertions)), Effect.orDie),
  ) as unknown as Effect.Effect<void, unknown, never>
  return Effect.runPromise(effect)
}

const text = (outcome: Outcome): string => {
  if (outcome.status !== "completed") return ""
  const content = outcome.content as ReadonlyArray<{ type: string; text?: string }> | undefined
  return (content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n")
}

const gatewayOf = (outcome: Outcome): Record<string, unknown> | undefined =>
  (outcome.metadata as Record<string, unknown> | undefined)?.gateway as Record<string, unknown> | undefined

const toolNames = (api: Api) => api.executions.map((entry) => entry.tool)

const rows = (storage: Storage.Interface, session: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return {
        gateway: yield* listGatewayUsage(storage, { session }),
        tools: yield* listToolUsage(storage, { session }),
      }
    }),
  )

describe("repository gateway over the real registry", () => {
  test("grep, glob and read swap to the graph, stamp provenance, and record usage", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, { banyancode_read_outline_lines: 40, banyancode_router_trace: true })

      await runScenario(directory, {}, (api) =>
        Effect.gen(function* () {
          const grep = yield* api.execute({ id: "call-grep", name: "grep", input: { pattern: "handleRequest" } })
          expect(grep.status).toBe("completed")
          expect(text(grep)).toContain("Usages")
          expect(text(grep)).toEndWith(
            "[gateway: grep -> code_find (usages). Comments and strings are not included. Repeat this grep for raw text.]",
          )
          expect(gatewayOf(grep)).toMatchObject({
            route: "swapped",
            from: "grep",
            to: "code_find",
            op: "usages",
            reason: "identifier",
          })
          expect(grep.metadata).toMatchObject({ codegraph: true })

          // The escape hatch: the identical call runs the real grep.
          const repeat = yield* api.execute({ id: "call-grep-repeat", name: "grep", input: { pattern: "handleRequest" } })
          expect(text(repeat)).toContain("export function handleRequest")
          expect(gatewayOf(repeat)).toMatchObject({ route: "direct", from: "grep", reason: "repeat" })

          const glob = yield* api.execute({ id: "call-glob", name: "glob", input: { pattern: "**/*.ts" } })
          expect(gatewayOf(glob)).toMatchObject({ route: "swapped", from: "glob", to: "repo", op: "files" })
          expect(text(glob)).toContain("src/large.ts")

          const read = yield* api.execute({ id: "call-read", name: "read", input: { path: "src/large.ts" } })
          expect(text(read)).toContain("symbols (")
          expect(gatewayOf(read)).toMatchObject({ route: "swapped", from: "read", to: "repo", op: "outline" })
          expect(gatewayOf(read)?.bytesSaved).toBeGreaterThan(0)
          expect(text(read)).toEndWith(
            "[gateway: read -> repo (outline). Symbols only, not the file body. Repeat this read for raw text.]",
          )

          // The repeat read returns the real file text.
          const rawRead = yield* api.execute({ id: "call-read-repeat", name: "read", input: { path: "src/large.ts" } })
          expect(text(rawRead)).toStartWith("Read file src/large.ts, lines 1-")
          expect(text(rawRead)).toContain("large0")
          expect(gatewayOf(rawRead)).toMatchObject({ route: "direct", from: "read", reason: "repeat" })

          // A small file is a real read with the symbol header.
          const small = yield* api.execute({ id: "call-read-small", name: "read", input: { path: "src/auth.ts" } })
          expect(text(small)).toStartWith("Symbol: AuthManager")
          expect(gatewayOf(small)).toMatchObject({ route: "augmented", from: "read", reason: "symbol-header" })

          expect(toolNames(api)).toEqual(["code_find", "grep", "repo", "repo", "read", "read"])

          const usage = yield* Effect.promise(() => rows(api.storage, sessionID))
          expect(usage.gateway.summary.swapped).toBe(3)
          expect(usage.gateway.summary.augmented).toBe(1)
          expect(usage.gateway.summary.direct).toBe(2)
          expect(usage.gateway.summary.bytesSaved).toBeGreaterThan(0)
          const swapped = usage.gateway.rows.filter((row) => row.route === "swapped")
          expect(swapped.map((row) => `${row.fromTool}->${row.toTool}`).sort()).toEqual([
            "glob->repo",
            "grep->code_find",
            "read->repo",
          ])
          // Rows hold the tool that actually ran.
          expect(usage.tools.tools.map((row) => row.toolId)).toContain("code_find")
          expect(usage.tools.tools.map((row) => row.toolId)).toContain("repo")
          expect(usage.tools.tools.map((row) => row.toolId)).toContain("grep")

          const traces = yield* Effect.promise(() => traceLines(directory))
          expect(traces.filter((trace) => trace.route === "swap")).toHaveLength(3)
          expect(traces.find((trace) => trace.originalTool === "read" && trace.reason === "repeat")).toMatchObject({
            route: "direct",
          })
        }),
      )
    })
  }, 90_000)

  test("an outline read does not block a later edit (nothing requires a real read first)", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, { banyancode_read_outline_lines: 40 })

      await runScenario(directory, {}, (api) =>
        Effect.gen(function* () {
          const outline = yield* api.execute({ id: "call-read", name: "read", input: { path: "src/large.ts" } })
          expect(gatewayOf(outline)).toMatchObject({ route: "swapped", to: "repo" })

          const edit = yield* api.execute({
            id: "call-edit",
            name: "edit",
            input: { path: "src/large.ts", oldString: "  const v0 = 0", newString: "  const v0 = 100" },
          })
          expect(edit.status).toBe("completed")
          expect(
            yield* Effect.promise(() => Bun.file(join(directory, "src/large.ts")).text()),
          ).toContain("const v0 = 100")
        }),
      )
    })
  }, 60_000)

  test("a ranged, documentation, config or outside-project read always runs the real read", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, { banyancode_read_outline_lines: 40 })
      const external = await mkdtemp(join(tmpdir(), "banyancode-gateway-external-"))
      const externalFile = join(external, "outside.ts")
      await writeFile(externalFile, LARGE_SRC, "utf8")
      try {
        await runScenario(directory, {}, (api) =>
          Effect.gen(function* () {
            const ranged = yield* api.execute({
              id: "call-ranged",
              name: "read",
              input: { path: "src/large.ts", offset: 1, limit: 5 },
            })
            expect(text(ranged)).toContain("Read file src/large.ts, lines 1-5")
            expect(text(ranged)).toStartWith("Symbol: large0")
            expect(gatewayOf(ranged)).toMatchObject({ route: "augmented", from: "read", reason: "symbol-header" })

            const docs = yield* api.execute({ id: "call-docs", name: "read", input: { path: "docs/README.md" } })
            expect(gatewayOf(docs)).toMatchObject({ route: "direct", reason: "docs" })

            const config = yield* api.execute({ id: "call-config", name: "read", input: { path: "package.json" } })
            expect(gatewayOf(config)).toMatchObject({ route: "direct", reason: "config" })

            // Outside the project root: the gateway refuses, and the read leaf's
            // external_directory approval still applies.
            const outside = yield* api.execute({ id: "call-outside", name: "read", input: { path: externalFile } })
            expect(outside.status).toBe("completed")
            expect(gatewayOf(outside)).toMatchObject({ route: "direct", reason: "outside-project" })
            expect(api.assertions.some((assertion) => assertion.action === "external_directory")).toBe(true)
            expect(toolNames(api)).toEqual(["read", "read", "read", "read"])
          }),
        )
      } finally {
        await rm(external, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    })
  }, 90_000)

  test("an unbuilt graph falls back to the original tools", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, { banyancode_read_outline_lines: 40 })

      await runScenario(directory, { index: false }, (api) =>
        Effect.gen(function* () {
          const grep = yield* api.execute({ id: "call-grep", name: "grep", input: { pattern: "handleRequest" } })
          expect(gatewayOf(grep)).toMatchObject({ route: "fallback", from: "grep", reason: "graph-unbuilt" })
          expect(text(grep)).toContain("export function handleRequest")

          const read = yield* api.execute({ id: "call-read", name: "read", input: { path: "src/large.ts" } })
          expect(gatewayOf(read)).toMatchObject({ route: "fallback", from: "read", reason: "graph-unbuilt" })
          expect(text(read)).toStartWith("Read file src/large.ts")

          expect(toolNames(api)).toEqual(["grep", "read"])
        }),
      )
    })
  }, 60_000)

  test("a denied target tool falls back before anything runs", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, { banyancode_read_outline_lines: 40 })
      const permissions: Rules = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "code_find", resource: "*", effect: "deny" },
      ]

      await runScenario(directory, { permissions }, (api) =>
        Effect.gen(function* () {
          const grep = yield* api.execute({ id: "call-grep", name: "grep", input: { pattern: "handleRequest" } })
          expect(gatewayOf(grep)).toMatchObject({ route: "fallback", from: "grep", reason: "tool-unavailable" })
          expect(toolNames(api)).toEqual(["grep"])
        }),
      )
    })
  }, 60_000)

  test("every rewrite target decodes with the real tool schema, and Code Mode cannot call these leaves", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)

      await runScenario(directory, {}, (api) =>
        Effect.gen(function* () {
          const rewrites: ReadonlyArray<{ readonly tool: string; readonly input: Record<string, unknown> }> = [
            { tool: "code_find", input: { intent: "usages", target: "AuthManager" } },
            { tool: "code_find", input: { intent: "usages", target: "AuthManager", path: "src/auth.ts" } },
            { tool: "code_find", input: { intent: "usages", target: "AuthManager", include: "*.ts" } },
            { tool: "repo", input: { op: "files", pattern: "**/*.ts" } },
            { tool: "repo", input: { op: "outline", path: "src/auth.ts" } },
          ]
          for (const rewrite of rewrites) {
            const schema = api.schemaOf(rewrite.tool)
            expect(schema, `${rewrite.tool} schema is not registered`).toBeDefined()
            expect(yield* api.decode(schema, rewrite.input)).toEqual(rewrite.input)
          }

          // read/grep/glob are direct-only: a Code Mode program has no way to
          // invoke them, so the rewrite path is the direct snapshot only.
          for (const name of ["read", "grep", "glob"]) {
            expect(api.toolOptions(name)?.codemode, `${name} must stay a direct tool`).toBe(false)
          }
          // The rewrite targets are Code Mode tools, so a direct call can reach them.
          for (const name of ["code_find", "repo"]) {
            expect(api.toolOptions(name)?.codemode).not.toBe(false)
          }
        }),
      )
    })
  }, 60_000)
})
