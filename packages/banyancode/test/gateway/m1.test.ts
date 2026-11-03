/**
 * M1 proof for the v2 repository gateway (v1 parity: `packages/core/test/banyancode/gateway-m1.test.ts`).
 *
 * Everything here runs the REAL execution path a model call takes:
 *
 *   Tool.Service.snapshot(permissions).execute({ call, definitions })
 *     → `execute.before` hooks (the real `Gateway.register` mounted at `src/server.ts:203`)
 *     → the resolved tool's real `execute`
 *     → `execute.after` hooks
 *
 * The leaves are the real core `read` / `grep` / `glob` plugins, the graph tools are the real
 * banyancode `Tool.Info` values `src/codegraph/index.ts:363-375` registers, and the graph itself is
 * a REAL index of fixture files into a throwaway SQLite database (real indexer, tree-sitter,
 * `codegraph_files`/`codegraph_nodes`/`codegraph_edges`, stamped meta row).
 *
 * Call paths: `snapshot.execute` is the direct path, which is the only one that can carry a
 * rewrite — read/grep/glob are registered `codemode: false`, so they are always direct tools and
 * the gateway can never rewrite a call inside a Code Mode program. `Tool.check` is the Code Mode
 * path; the rewrite-to-CodeMode-tool and fail-closed cases live in
 * `packages/core/test/plugin/tool-input-repair-integration.test.ts`.
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
import { make as makeAnalyzer } from "../../src/codegraph/codegraph-analyzer.js"
import { makeService as makeSearchService } from "../../src/codegraph/search/search.js"
import { make as makeStructural } from "../../src/codegraph/structural-queries/structural-queries.js"
import { tools as codegraphTools } from "../../src/codegraph/tools/codegraph.js"
import { tool as codeFindTool } from "../../src/codegraph/tools/code-find.js"
import { tool as searchTool } from "../../src/codegraph/tools/codegraph-search-tool.js"
import { tools as structuralTools } from "../../src/codegraph/tools/structural-queries-tool.js"
import { make as makeCodegraphQuery } from "../../src/integration/codegraph-query.js"
import { ExplainInput, OwnershipInput } from "../../src/intel/types.js"
import { register as registerGateway } from "../../src/gateway/index.js"

// The core host is imported dynamically: `@banyancode/plugin` must not depend on
// `@opencode/core` in production (core depends on this plugin), and the package typecheck
// program stays scoped to banyancode. Same pattern as `test/integration/boot.test.ts`.
const core = (path: string) => import(["..", "..", "..", "core", path].join("/"))
const { AppNodeBuilder } = await core("src/effect/app-node-builder.js")
const { Tool } = await core("src/tool.js")
const { PluginHooks } = await core("src/plugin/hooks.js")
const { Environment } = await core("src/environment/index.js")
const { Ripgrep } = await core("src/ripgrep.js")
const { FileAccess } = await core("src/file-access.js")
const { ReadToolFileSystem } = await core("src/tool/read-filesystem.js")
const { Location } = await core("src/location.js")
const { Permission } = await core("src/permission.js")
const { SessionInstructions } = await core("src/session/instructions.js")
const { ReadTool } = await core("src/tool/plugin/read.js")
const { GrepTool } = await core("src/tool/plugin/grep.js")
const { GlobTool } = await core("src/tool/plugin/glob.js")
const { Session } = await core("src/session.js")
const { SessionMessage } = await core("src/session/message.js")
const { Agent } = await core("src/agent.js")
const { AbsolutePath } = await core("src/schema.js")
const { location: fixtureLocation } = await core("test/fixture/location.js")
const { permissionLayer } = await core("test/lib/permission.js")
const { registerToolPlugin } = await core("test/lib/tool.js")
const { host } = await core("test/plugin/host.js")

// This file owns the env: router selection consults BANYANCODE_ROUTER before config, which
// would silently override every scenario below.
process.env.BANYANCODE_ENABLE = "1"
delete process.env.BANYANCODE_ROUTER
delete process.env.BANYANCODE_ROUTER_TRACE

// --- Fixture files (the leaves search these) ---------------------------------

const AUTH_SRC = ["export class AuthManager {", "  constructor() {}", "}", ""].join("\n")
const SERVER_SRC = [
  'import { AuthManager } from "./auth"',
  "",
  "export function handleRequest() {",
  "  const manager = new AuthManager()",
  "  return manager",
  "}",
  "",
].join("\n")
const README_SRC = ["# Fixture Docs", "", "The authentication flow is documented here.", ""].join("\n")

const FIXTURE_FILES = [
  ["src/auth.ts", AUTH_SRC],
  ["src/server.ts", SERVER_SRC],
  ["docs/README.md", README_SRC],
] as const

const sessionID = Session.ID.make("ses_m1")
const identity = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_m1"),
}

const toolCall = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool-call" as const,
  id,
  name,
  input,
})

type Execution = { readonly tool: string; readonly input: unknown; readonly status: string }
/** A settle outcome: `status` for the branch, every other field is the executor's own. */
type Outcome = { readonly status: "completed" | "error"; readonly [key: string]: unknown }
type CallInput = { readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
type Rewrite = { readonly tool: string; readonly input: Record<string, unknown> }

interface Api {
  readonly execute: (input: CallInput) => Effect.Effect<Outcome>
  readonly executions: readonly Execution[]
  readonly availableTools: ReadonlySet<string>
  readonly toolsByName: ReadonlyMap<string, { readonly input: unknown }>
  /** The real codegraph seam, driven with an explicit operation. */
  readonly route: (operation: unknown) => Effect.Effect<Rewrite | undefined>
  /** Decode a rewrite input with the target tool's input schema. */
  readonly decode: (schema: unknown, input: unknown) => Effect.Effect<unknown, unknown>
}

interface Scenario {
  readonly config?: Readonly<Record<string, unknown>>
  readonly gateway?: boolean
  /** Where `repository_route` traces go (defaults to the fixture directory). Kept apart from the
   * search root in trace assertions: a trace line records the arguments, so a later grep would
   * legitimately find its own trace. */
  readonly traceDir?: string
  /** Permission ruleset the request snapshot is built with (the agent's allowed tools). */
  readonly permissions?: ReadonlyArray<{
    readonly action: string
    readonly resource: string
    readonly effect: "allow" | "deny"
  }>
}

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-m1-"))
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

/** Traces record their own arguments, so trace assertions use a directory outside the search root. */
const withTrace = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-m1-trace-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
const traceLines = async (directory: string): Promise<Record<string, unknown>[]> => {  const file = Bun.file(join(directory, ".banyancode", "trace", `${sessionID}.jsonl`))
  if (!(await file.exists())) return []
  return (await file.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// --- The real runtime ---------------------------------------------------------

const runtimeFor = (directory: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Tool.node,
      // `group` exposes only its roots; a dependency of `Tool.node` is private otherwise.
      PluginHooks.node,
      Environment.node,
      Ripgrep.node,
      FileAccess.node,
      ReadToolFileSystem.node,
      Location.node,
      Permission.node,
      SessionInstructions.node,
      FSUtil.node,
    ]),
    [
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            fixtureLocation(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
          ),
        ),
      ),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void, allows: () => Effect.succeed(true) })),
      // The fixture has no AGENTS.md, so instruction discovery never runs; the service only has
      // to exist for the read plugin to construct.
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
  const effect = Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      const storage = yield* Storage.open({ projectRoot: directory, env: {} })
      const repo = makeRepo(storage)

      // Real index of the fixture: files, nodes, edges and a stamped meta row (the codegraph
      // query refuses to rewrite onto the graph without meta).
      const indexer = yield* makeIndexer(repo, storage)
      const indexed = yield* indexer.index({ root: directory, force: true })
      yield* repo.bumpVersion({ eligibleFiles: indexed.eligibleFiles, indexedRoot: directory })

      const buildService = yield* makeBuildService({ indexer, repo, dbPath: () => storage.path })
      const readiness = yield* makeReadiness({ buildService, repo })
      const analyzer = makeAnalyzer(repo)
      const search = makeSearchService(repo)
      const structural = makeStructural(repo)
      const projectRoot = () => directory

      const toolHook = (name: string, callback: unknown) => hooks.register("tool", name, callback as never)
      const ctx = host({
        // `Gateway.register` derives the trace worktree from the location's project; the tools
        // read through Location.Service. Tests keep the trace out of the search root.
        location: fixtureLocation(
          Location.Ref.make({ directory: AbsolutePath.make(scenario.traceDir ?? directory) }),
        ),
        tool: { transform: tools.transform, reload: tools.reload, list: tools.list, hook: toolHook },
        session: { context: () => Effect.succeed([]) },
      })

      // 1. The real core leaves (read/grep/glob) through the real registry.
      yield* registerToolPlugin(ReadTool.Plugin, { location: ctx.location }, toolHook)
      yield* registerToolPlugin(GrepTool.Plugin, { location: ctx.location }, toolHook)
      yield* registerToolPlugin(GlobTool.Plugin, { location: ctx.location }, toolHook)

      // 2. The real graph tools `src/codegraph/index.ts:363-375` registers.
      const registered = [
        ...codegraphTools({ repo, analyzer, buildService, projectRoot }),
        codeFindTool({ repo, analyzer, readiness, projectRoot }),
        searchTool({ repo, search, structural }),
        ...structuralTools({ structural }),
      ]
      yield* tools.transform((editor: any) => {
        for (const tool of registered) editor.add(tool)
      })

      // 3. The gateway, as `src/server.ts:193-203` mounts it: the allowed-tool gate is the
      //    global registration list; execution resolves against the per-request one.
      const availableTools: ReadonlySet<string> = new Set(
        (yield* tools.list()).map((tool: any) => tool.id as string),
      )
      const config = BanyanConfig.make({
        directory,
        projectRoot: directory,
        globalDir: join(directory, "global-config"),
        home: directory,
        env: {},
      })
      if (scenario.gateway !== false) {
        yield* registerGateway(ctx, {
          storage,
          config,
          codegraph: makeCodegraphQuery(repo, { availableTools }),
        })
      }

      // 4. Sentinel: every tool that actually executed, with the input it ran with. A rewritten
      //    call never settles the original leaf, so `grep` must not appear for one.
      const executions: Execution[] = []
      yield* hooks.register("tool", "execute.after", (event: { tool: string; input: unknown; status: string }) =>
        Effect.sync(() => {
          executions.push({ tool: event.tool, input: event.input, status: event.status })
        }),
      )

      const execute = (input: CallInput): Effect.Effect<Outcome> =>
        Effect.gen(function* () {
          const snapshot: any = yield* tools.snapshot(scenario.permissions)
          // Exactly what `session/model-request.ts:302-307` hands the executor: the definitions
          // advertised for this request, keyed by advertised name.
          const definitions = new Map(snapshot.definitions.map((tool: any) => [tool.name, tool] as const))
          const exit = yield* snapshot
            .execute({ ...identity, definitions, call: toolCall(input.id, input.name, input.input) })
            .pipe(Effect.exit)
          if (Exit.isSuccess(exit)) return { status: "completed" as const, ...(exit.value as object) }
          return { status: "error" as const, error: Option.getOrUndefined(Exit.findErrorOption(exit)) }
        }) as unknown as Effect.Effect<Outcome>

      const toolsByName = new Map<string, { readonly input: unknown }>(
        [...registered, ...(yield* tools.list())].map((tool: any) => [tool.name ?? tool.id, tool] as const),
      )
      const query = makeCodegraphQuery(repo)

      yield* body({
        execute,
        executions,
        availableTools,
        toolsByName,
        route: (operation) =>
          query.route === undefined
            ? Effect.succeed(undefined)
            : query.route({ operation: operation as never, call: { tool: "grep", input: {} }, sessionID }),
        decode: (schema, input) => Schema.decodeUnknownEffect(schema as never)(input).pipe(Effect.orDie),
      })
    }).pipe(Effect.provide(runtimeFor(directory)), Effect.orDie),
  ) as unknown as Effect.Effect<void, unknown, never>
  return Effect.runPromise(effect)
}

const text = (outcome: Outcome): string => {
  if (outcome.status !== "completed") return ""
  const content = outcome.content as ReadonlyArray<{ type: string; text?: string }> | undefined
  return (content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n")
}

const toolNames = (api: Api) => api.executions.map((entry) => entry.tool)

/** Glob lists files in ripgrep's enumeration order, which the OS does not keep stable. */
const listedPaths = (outcome: Outcome): string[] =>
  ((outcome.output as ReadonlyArray<{ path: string }> | undefined) ?? []).map((entry) => entry.path).sort()

/** Byte-identical apart from list ordering: status, metadata, and the same items. */
const expectSameSettle = (got: Outcome, want: Outcome) => {
  expect(got.status).toBe(want.status)
  expect(got.metadata).toEqual(want.metadata)
  expect(listedPaths(got)).toEqual(listedPaths(want))
  expect(text(got).split("\n").sort()).toEqual(text(want).split("\n").sort())
}

describe("M1 — read/grep/glob reach the graph through the real registry execution path", () => {
  test("read of a code file carries the symbol header; router off and augment off stay byte-identical", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, {})

      let baseline: Outcome | undefined
      await runScenario(directory, { gateway: false }, (api) =>
        Effect.gen(function* () {
          baseline = yield* api.execute({ id: "call-read-baseline", name: "read", input: { path: "src/auth.ts" } })
        }),
      )
      expect(baseline?.status).toBe("completed")
      const base = baseline!
      const baselineText = text(base)
      expect(baselineText).toContain("export class AuthManager")
      expect(baselineText).toStartWith("Read file src/auth.ts, lines 1-")
      expect(base.metadata).toEqual({ truncated: false })

      await runScenario(directory, {}, (api) =>
        Effect.gen(function* () {
          const outcome = yield* api.execute({ id: "call-read-gateway", name: "read", input: { path: "src/auth.ts" } })
          expect(outcome.status).toBe("completed")
          if (outcome.status !== "completed") return
          // Model-facing page: the graph-derived header, then the exact page the leaf produced.
          expect(text(outcome)).toBe(
            `Symbol: AuthManager | Imports: 0 | References: 0 | Callers: 1 | Dependents: 0\n${baselineText}`,
          )
          expect(outcome.metadata).toEqual({ truncated: false, codegraph: true })
          // The structured page (what storage and the TUI read) stays the leaf's own value.
          expect(outcome.output).toEqual(base.output)
          expect((outcome.output as { type?: string }).type).toBe("file")
          // The gateway augmented the real read; it did not substitute another tool.
          expect(toolNames(api)).toEqual(["read"])
        }),
      )

      // `banyancode_augment_read: false` keeps the read byte-identical to the gateway-absent run.
      await writeConfig(directory, { banyancode_augment_read: false })
      await runScenario(directory, {}, (api) =>
        Effect.gen(function* () {
          const outcome = yield* api.execute({ id: "call-read-noaugment", name: "read", input: { path: "src/auth.ts" } })
          expect(outcome).toEqual(base)
        }),
      )
    })
  }, 60_000)

  test('banyancode_router: "off" settles exactly like the gateway-absent run', async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, { banyancode_router: "off" })
      const inputs: readonly CallInput[] = [
        { id: "call-off-grep", name: "grep", input: { pattern: "who calls AuthManager" } },
        { id: "call-off-read", name: "read", input: { path: "src/auth.ts" } },
        { id: "call-off-glob", name: "glob", input: { pattern: "*.ts", path: "src" } },
      ]

      let baseline: Outcome[] = []
      await runScenario(directory, { gateway: false }, (api) =>
        Effect.gen(function* () {
          const results: Outcome[] = []
          for (const input of inputs) results.push(yield* api.execute(input))
          baseline = results
        }),
      )
      await runScenario(directory, {}, (api) =>
        Effect.gen(function* () {
          const results: Outcome[] = []
          for (const input of inputs) results.push(yield* api.execute(input))
          // Read and grep settle byte-identically; glob lists the same files in an unstable order.
          expect(results[0]).toEqual(baseline[0])
          expect(results[1]).toEqual(baseline[1])
          expectSameSettle(results[2]!, baseline[2]!)
          // No graph answer leaks through the opt-out install.
          expect(text(results[0]!)).toBe("No matches found")
          expect((results[1] as { metadata?: unknown }).metadata).toEqual({ truncated: false })
          expect(toolNames(api)).toEqual(["grep", "read", "glob"])
        }),
      )
    })
  }, 60_000)

  test("a relationship grep executes the rewritten codegraph tool, never grep, and traces the route", async () => {
    await withTemp(async (directory) => {
      await withTrace(async (traceDir) => {
        await writeFixture(directory)
        await writeConfig(directory, { banyancode_router_trace: true })

        let leafResult: Outcome | undefined
        await runScenario(directory, { gateway: false }, (api) =>
          Effect.gen(function* () {
            leafResult = yield* api.execute({
              id: "call-grep-leaf",
              name: "grep",
              input: { pattern: "who calls AuthManager" },
            })
          }),
        )
        // The leaf alone cannot answer: the phrase is not in any fixture file.
        expect(text(leafResult!)).toBe("No matches found")

        await runScenario(directory, { traceDir }, (api) =>
          Effect.gen(function* () {
            const outcome = yield* api.execute({
              id: "call-grep-graph",
              name: "grep",
              input: { pattern: "who calls AuthManager" },
            })
            expect(outcome.status).toBe("completed")
            if (outcome.status !== "completed") return
            const answer = text(outcome)
            // The graph's caller row is what the model gets: `handleRequest` at its indexed lines,
            // which the leaf cannot produce for this phrase.
            expect(answer).toContain("Callers (1)")
            expect(answer).toContain("handleRequest")
            expect(answer).not.toBe("No matches found")
            expect(outcome.metadata).toEqual({ codegraph: true })
            // Only the rewritten tool ran: `grep` is still a gateway tool, but the hook rewrote
            // the call before execution, so the grep leaf never settles.
            expect(api.executions).toEqual([
              { tool: "codegraph_callers", input: { function: "AuthManager", limit: 200 }, status: "completed" },
            ])
          }),
        )

        const traces = await traceLines(traceDir)
        expect(traces).toHaveLength(1)
        expect(traces[0]).toMatchObject({
          event: "repository_route",
          originalTool: "grep",
          route: "intelligence",
          backend: "codegraph",
          router: "rules",
          routerVersion: "0.1.0",
          graphFreshness: "unavailable",
        })
        expect(traces[0]!.reasonCodes as readonly string[]).toContain("relationship-language")
      })
    })
  }, 60_000)

  test("a rewrite the request cannot run fails closed to the original grep call", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, {})

      await runScenario(
        directory,
        {
          // An agent whose allowed tools exclude the codegraph tools. The gateway's
          // `availableTools` gate reads the global registry, so it still rewrites; execution is
          // what must fall back.
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "codegraph_callers", resource: "*", effect: "deny" },
          ],
        },
        (api) =>
          Effect.gen(function* () {
            const outcome = yield* api.execute({
              id: "call-grep-fallback",
              name: "grep",
              input: { pattern: "who calls AuthManager" },
            })
            expect(outcome.status).toBe("completed")
            if (outcome.status !== "completed") return
            // Not an unavailable-tool error: the original call runs unchanged, and the result is
            // not stamped as graph-derived.
            expect(text(outcome)).toBe("No matches found")
            expect(outcome.metadata).toEqual({ matches: 0, truncated: false })
            expect(api.executions).toEqual([
              { tool: "grep", input: { pattern: "who calls AuthManager" }, status: "completed" },
            ])
          }),
      )
    })
  }, 60_000)

  test("literal, docs-scoped, glob and scoped-relationship searches stay direct", async () => {
    await withTemp(async (directory) => {
      await withTrace(async (traceDir) => {
        await writeFixture(directory)
        await writeConfig(directory, { banyancode_router_trace: true })
        const inputs: readonly CallInput[] = [
          { id: "call-literal", name: "grep", input: { pattern: "TODO" } },
          { id: "call-docs", name: "grep", input: { pattern: "who calls AuthManager", path: "docs" } },
          { id: "call-glob", name: "glob", input: { pattern: "*.ts", path: "src" } },
          { id: "call-include", name: "grep", input: { pattern: "who calls AuthManager", include: "*.ts" } },
          { id: "call-path", name: "grep", input: { pattern: "who calls AuthManager", path: "src" } },
        ]

        let baseline: Outcome[] = []
        await runScenario(directory, { gateway: false }, (api) =>
          Effect.gen(function* () {
            const results: Outcome[] = []
            for (const input of inputs) results.push(yield* api.execute(input))
            baseline = results
          }),
        )

        await runScenario(directory, { traceDir }, (api) =>
          Effect.gen(function* () {
            const results: Outcome[] = []
            for (const input of inputs) results.push(yield* api.execute(input))
            // Grep settles byte-identically; glob lists the same files in an unstable order, so it
            // is compared item-wise.
            for (let index = 0; index < inputs.length; index += 1) {
              if (inputs[index]!.name === "glob") expectSameSettle(results[index]!, baseline[index]!)
              else expect(results[index]).toEqual(baseline[index])
            }
            // The leaves are what ran — no codegraph tool was substituted.
            expect(toolNames(api)).toEqual(["grep", "grep", "glob", "grep", "grep"])
          }),
        )

        const traces = await traceLines(traceDir)
        expect(traces).toHaveLength(inputs.length)
        const find = (needle: string) =>
          traces.filter((trace) => Object.values(trace.arguments as Record<string, unknown>).includes(needle))
        expect(find("TODO")[0]).toMatchObject({ route: "direct", backend: "filesystem" })
        expect(find("TODO")[0]!.reasonCodes as readonly string[]).toContain("literal-query")
        expect(find("docs")[0]).toMatchObject({ route: "direct" })
        expect(find("docs")[0]!.reasonCodes as readonly string[]).toContain("docs-scoped")
        expect(find("src")[0]).toMatchObject({ route: "direct" })

        // Scoped relationship language is v1's `hybrid-direct-failsafe`: graph and text are both
        // plausible, so the text index stays in charge and the trace records why.
        const scoped = traces.filter((trace) =>
          (trace.reasonCodes as readonly string[]).includes("hybrid-direct-failsafe"),
        )
        expect(scoped).toHaveLength(2)
        for (const trace of scoped) {
          expect(trace.route).toBe("direct")
          expect(trace.backend).toBe("filesystem")
          expect(trace.reasonCodes as readonly string[]).toContain("scoped-path")
          expect(trace.reasonCodes as readonly string[]).toContain("relationship-language")
        }
      })
    })
  }, 60_000)

  test("every rewrite input decodes with the real target tool schema", async () => {
    await withTemp(async (directory) => {
      await writeFixture(directory)
      await writeConfig(directory, {})

      await runScenario(directory, { gateway: false }, (api) =>
        Effect.gen(function* () {
          // The ids the gateway's route table names must be registered under exactly these names,
          // no namespace prefix.
          for (const id of [
            "code_find",
            "codegraph_callers",
            "codegraph_dependents",
            "codegraph_find_implementations",
            "codegraph_search",
          ]) {
            expect(api.availableTools.has(id), `${id} is not registered`).toBe(true)
          }

          const operations: ReadonlyArray<{
            readonly operation: unknown
            readonly tool?: string
            /** Targets not mounted in this focused layer (intel) decode against their own schema. */
            readonly schema?: unknown
          }> = [
            { operation: { kind: "symbol", query: "AuthManager" }, tool: "code_find" },
            { operation: { kind: "relationship", relation: "callers", target: "AuthManager" }, tool: "codegraph_callers" },
            { operation: { kind: "relationship", relation: "references", target: "AuthManager" }, tool: "codegraph_callers" },
            { operation: { kind: "relationship", relation: "dependents", target: "AuthManager" }, tool: "codegraph_dependents" },
            {
              operation: { kind: "relationship", relation: "implementations", target: "AuthManager" },
              tool: "codegraph_find_implementations",
            },
            {
              operation: { kind: "relationship", relation: "extensions", target: "AuthManager" },
              tool: "codegraph_find_implementations",
            },
            { operation: { kind: "structural", query: "AuthManager" }, tool: "codegraph_search" },
            // No clean graph mapping: the seam must decline so the gateway stays fail-closed.
            { operation: { kind: "relationship", relation: "imports", target: "AuthManager" }, tool: undefined },
            { operation: { kind: "text_search", pattern: "TODO" }, tool: undefined },
            { operation: { kind: "content", path: "src/auth.ts" }, tool: undefined },
            { operation: { kind: "file_discovery", pattern: "*.ts" }, tool: undefined },
            // Unreachable from `deriveOperation` today (it only produces symbol/relationship), but
            // the route table still has to name a real tool with the shape it emits. The intel
            // workstream is not mounted here, so the schema comes from its source of truth.
            {
              operation: { kind: "architecture", query: "AuthManager" },
              tool: "repository_explain",
              schema: ExplainInput,
            },
            { operation: { kind: "ownership", query: "src/auth.ts" }, tool: "repository_ownership", schema: OwnershipInput },
          ]

          for (const entry of operations) {
            const rewrite = yield* api.route(entry.operation)
            if (entry.tool === undefined) {
              expect(rewrite, `${(entry.operation as { kind: string }).kind} must not rewrite`).toBeUndefined()
              continue
            }
            expect(rewrite?.tool, `${(entry.operation as { kind: string }).kind} rewrite target`).toBe(entry.tool)
            const schema = entry.schema ?? api.toolsByName.get(entry.tool)?.input
            expect(schema, `${entry.tool} schema is not available`).toBeDefined()
            const decoded = yield* api.decode(schema, rewrite!.input)
            expect(decoded).toEqual(rewrite!.input)
          }
        }),
      )
    })
  }, 90_000)
})
