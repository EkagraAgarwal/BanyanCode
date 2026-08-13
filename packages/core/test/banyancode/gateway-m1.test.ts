import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, Schema, Scope } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Service as BanyanConfigService } from "../../src/banyancode/banyan-config"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import { ToolRouterService } from "../../src/banyancode/gateway/router"
import type { ToolRouter } from "../../src/banyancode/gateway/types"
import {
  RepositoryIntelligence,
  defaultLayer as repositoryIntelligenceDefaultLayer,
} from "../../src/banyancode/repository-intelligence"
import { BanyanConfig } from "../../src/v1/config/banyan-config"
import { tmpdir } from "../fixture/tmpdir"
import { settleTool } from "../lib/tool"

process.env.BANYANCODE_ENABLE = "1"
// The gateway's router selection consults BANYANCODE_ROUTER first (it would
// override both the config key and the default). This file owns its env.
delete process.env.BANYANCODE_ROUTER
delete process.env.BANYANCODE_ROUTER_TRACE

// =============================================================================
// M1 proof (spec §155 / plan §6 M1): a model-equivalent agent that only calls
// read/grep/glob completes repository-semantic tasks via Banyan graph
// infrastructure without ever calling a codegraph-specific tool.
//
// Everything below runs the REAL ToolRegistry.settleWith interception path
// end-to-end: real probe leaves registered through the real registry, the real
// RepositoryGateway (defaultLayer → RulesRouter unless noted), the real
// RepositoryIntelligence service, and a REAL codegraph seeded into a tmpdir
// SQLite database. No gateway/backend/intel mocks — only the ToolOutputStore
// bound mock (identical to every other gateway registry test) and a
// BanyanConfigService double for the "off" install (scenario 4).
// =============================================================================

// --- Fixture: real files on disk (the leaves read/grep/glob over) -----------

const AUTH_SRC = `export class AuthManager {
  constructor() {}
}
`
const SERVER_SRC = `import { AuthManager } from "./auth"

export function handleRequest() {
  const manager = new AuthManager()
  return manager
}
`
const README_SRC = `# Fixture Docs

The authentication flow is documented here.
`

const FIXTURE_FILES = [
  { rel: "src/auth.ts", content: AUTH_SRC },
  { rel: "src/server.ts", content: SERVER_SRC },
  { rel: "docs/README.md", content: README_SRC },
] as const

// --- Fixture: real codegraph rows in the tmpdir DB --------------------------
// Mirrors repository-intelligence.test.ts: files + nodes + one `calls` edge
// (handleRequest in src/server.ts calls AuthManager in src/auth.ts).

const seedGraph = () =>
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    yield* repo.putFile({ id: "f-auth", path: "src/auth.ts", contentHash: "h1", language: "typescript", indexedAt: 1 })
    yield* repo.putFile({ id: "f-server", path: "src/server.ts", contentHash: "h2", language: "typescript", indexedAt: 2 })
    yield* repo.putFile({ id: "f-docs", path: "docs/README.md", contentHash: "h3", language: "markdown", indexedAt: 3 })
    yield* repo.putNode({
      id: "n-auth",
      fileID: "f-auth",
      kind: "class",
      name: "AuthManager",
      signature: "class AuthManager",
      startLine: 1,
      endLine: 4,
      code: AUTH_SRC,
    })
    yield* repo.putNode({
      id: "n-server",
      fileID: "f-server",
      kind: "function",
      name: "handleRequest",
      signature: "handleRequest()",
      startLine: 42,
      endLine: 60,
      code: SERVER_SRC,
    })
    yield* repo.putEdge({ id: "e-call", fromNodeID: "n-server", toNodeID: "n-auth", kind: "calls" })
  })

// --- Probe leaves ------------------------------------------------------------
// Sanctioned by the task: register Tool.make probes that mimic the read/grep/
// glob leaf behavior (text-page json for read, line matches for grep) through
// the REAL registry — the M1 point is the gateway hook + routing + graph
// substitution, not the leaf implementations.

type FixtureFile = { readonly rel: string; readonly content: string }

const grepLeaf = (files: readonly FixtureFile[], pattern: string, scope?: string): string => {
  const needle = pattern.toLowerCase()
  const out: string[] = []
  for (const file of files) {
    const dir = scope?.replace(/[\\/]+$/, "")
    if (scope !== undefined && file.rel !== dir && !file.rel.startsWith(`${dir}/`)) continue
    const lines = file.content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) out.push(`${file.rel}:${i + 1}: ${lines[i]}`)
    }
  }
  return out.length > 0 ? out.join("\n") : "No matches found"
}

const makeGrep = (files: readonly FixtureFile[]) =>
  Tool.make({
    description: "grep probe over the M1 fixture (leaf: line matches)",
    input: Schema.Struct({ pattern: Schema.String, path: Schema.String.pipe(Schema.optional) }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ pattern, path }) => Effect.succeed({ text: grepLeaf(files, pattern, path) }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })

const makeRead = (files: readonly FixtureFile[]) =>
  Tool.make({
    description: "read probe over the M1 fixture (leaf: text page)",
    input: Schema.Struct({ path: Schema.String }),
    output: Schema.Struct({
      type: Schema.Literal("text-page"),
      content: Schema.String,
      mime: Schema.String,
      offset: Schema.Number,
      truncated: Schema.Boolean,
    }),
    execute: ({ path }) => {
      const file = files.find((f) => f.rel === path)
      if (!file) return Effect.fail(new ToolFailure({ message: `Unable to read ${path}` }))
      return Effect.succeed({
        type: "text-page" as const,
        content: file.content,
        mime: "text/plain",
        offset: 1,
        truncated: false,
      })
    },
    toModelOutput: () => [],
  })

const makeGlob = (files: readonly FixtureFile[]) =>
  Tool.make({
    description: "glob probe over the M1 fixture (leaf: basename matches)",
    input: Schema.Struct({ pattern: Schema.String, path: Schema.String.pipe(Schema.optional) }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ pattern }) =>
      Effect.succeed({
        text: files
          .map((f) => f.rel)
          .filter((rel) => rel.split("/").pop()?.toLowerCase().endsWith(pattern.replace(/^\*/, "").toLowerCase()))
          .join("\n"),
      }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })

const probes = (files: readonly FixtureFile[]) => ({
  read: makeRead(files),
  grep: makeGrep(files),
  glob: makeGlob(files),
})

// --- Runtimes ----------------------------------------------------------------

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const registryLayer = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))

// Real RepositoryIntelligence + real CodegraphRepo; the tmpdir Database is
// provided per test as the runtime's provideMerge DEPENDENCY (the dependency
// layer wins on duplicates, so CodegraphRepo reads the tmpdir DB — verified
// empirically; same guarantee the repository-intelligence tests rely on).
const intelLayer = Layer.mergeAll(repositoryIntelligenceDefaultLayer, CodegraphRepo.defaultLayer)

// R1 — gateway absent: the byte-identical baseline.
const baselineLayer = registryLayer

// R2 — default install: real defaultLayer → RulesRouter (no BanyanConfigService
// in scope). This is the M1 install.
const defaultInstallLayer = Layer.provideMerge(registryLayer, RepositoryGateway.defaultLayer)

// R3 — explicit opt-out: banyancode_router: "off" → NoopRouter. The config
// mock must be a DIRECT dependency of the gateway layer: the gateway picks its
// router at BUILD time (routerFromConfig runs inside defaultLayer's
// construction gen), and a Layer.mergeAll sibling is NOT in scope for a
// member's build-time serviceOption — only a Layer.provideMerge dependency is
// (same wiring as gateway-direct.test.ts and the real app-runtime.ts:169).
const configWith = (flags: Partial<BanyanConfig.Info>) =>
  Layer.mock(BanyanConfigService, {
    get: () => Effect.succeed(flags),
    getGlobal: () => Effect.succeed({}),
    update: () => Effect.succeed({}),
    updateAgentOverride: () => Effect.succeed({}),
    getAgentOverrides: () => Effect.succeed({}),
    updateAgentPrompt: () => Effect.succeed({}),
  })
const offInstallLayer = Layer.provideMerge(
  registryLayer,
  Layer.provideMerge(RepositoryGateway.defaultLayer, configWith({ banyancode_router: "off" })),
)

// R4 — the AUGMENT route signal through the REAL gateway + REAL graph: the
// RulesRouter has no augment branch yet (every exact-content read routes
// DIRECT at precedence 1 — see scenario 3a and the finding in the summary),
// so the Phase 7 augment decision arrives through the ToolRouter seam, the
// same "future RulesRouter-variant signal" gateway-augment.test.ts drives —
// but here the header is built from a REAL graph, not an intel double.
const augmentContentRouter: ToolRouter = {
  classify: (input) =>
    Effect.succeed({
      route: "augment" as const,
      operation: {
        kind: "content" as const,
        path: typeof input.arguments.path === "string" ? input.arguments.path : "",
      },
      confidence: 1,
      reasonCodes: ["m1-augment-signal"],
      router: "rules",
      routerVersion: "0.1.0",
    }),
}
const augmentInstallLayer = Layer.provideMerge(
  registryLayer,
  RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, augmentContentRouter))),
)

// --- Runner: real DB + migrations + seeds + settle --------------------------

type Tmp = { readonly path: string; readonly [Symbol.asyncDispose]: () => Promise<void> }

// The scenario layers' common service set, kept CONCRETE so the runner can
// prove the settle effects' requirements (ToolRegistry etc.) against it.
// Every scenario layer provides at least the registry services; the gateway /
// config / router extras vary per layer (Layer's first parameter is
// contravariant — the declared type must be the common subset).
type ScenarioServices = Layer.Success<typeof registryLayer>

// Per-test runtime: the scenario stack + the REAL RepositoryIntelligence +
// CodegraphRepo layers + the tmpdir Database as the provideMerge dependency
// (the dependency layer wins on duplicates, so CodegraphRepo reads the tmpdir
// DB — verified empirically; same guarantee the repository-intelligence tests
// rely on).
const runtimeFor = (tmp: Tmp, scenarioLayer: Layer.Layer<ScenarioServices, never>) =>
  Layer.provideMerge(
    Layer.mergeAll(scenarioLayer, intelLayer),
    Database.layerFromPath(path.join(tmp.path, "test.db")),
  )

// R-bound runner (lib/effect.ts `make` pattern): R is inferred from the
// concrete runtime at this call, so the value's requirements are provable.
const makeRun = <R>(runtime: Layer.Layer<R, never>) => {
  const run = <A, E>(value: Effect.Effect<A, E, R | Scope.Scope>): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* value.pipe(Effect.scoped, Effect.provide(runtime), Effect.orDie, Effect.exit)
        return yield* exit
      }),
    )
  return run
}

// One settle against a fully-real runtime: migrate + seed the tmpdir graph,
// register the probes, settle the call.
const settleFor = (
  tmp: Tmp,
  scenarioLayer: Layer.Layer<ScenarioServices, never>,
  input: ToolRegistry.ExecuteInput,
): Promise<ToolRegistry.Settlement> =>
  makeRun(runtimeFor(tmp, scenarioLayer))(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      yield* seedGraph()
      const registry = yield* ToolRegistry.Service
      yield* registry.register(probes(FIXTURE_FILES))
      return yield* settleTool(registry, input)
    }),
  )

const settleAllFor = (
  tmp: Tmp,
  scenarioLayer: Layer.Layer<ScenarioServices, never>,
  inputs: readonly ToolRegistry.ExecuteInput[],
): Promise<ToolRegistry.Settlement[]> =>
  makeRun(runtimeFor(tmp, scenarioLayer))(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* DatabaseMigration.apply(db)
      yield* seedGraph()
      const registry = yield* ToolRegistry.Service
      yield* registry.register(probes(FIXTURE_FILES))
      return yield* Effect.forEach(inputs, (input) => settleTool(registry, input))
    }),
  )

// --- Call shapes -------------------------------------------------------------

const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_m1"),
}
const sessionID = SessionV2.ID.make("ses_m1")
const call = (name: string, input: Record<string, unknown>): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}-${JSON.stringify(input)}`, name, input },
})

// --- Expected values (derived from the seeded graph + Formatter) -------------

// slice().directCallers of AuthManager = [handleRequest @ src/server.ts:42];
// formatter renders "AuthManager callers:\n\nsrc/server.ts:42 (handleRequest)".
const EXPECTED_CALLERS_TEXT = "AuthManager callers:\n\nsrc/server.ts:42 (handleRequest)"

// augment header built from the real graph: symbol AuthManager in src/auth.ts,
// no outgoing dependencies, no "references" edges, 1 caller, no transitives.
const EXPECTED_AUGMENT_HEADER =
  "Symbol: AuthManager | Imports: 0 | References: 0 | Callers: 1 | Dependents: 0"

const EXPECTED_GREP_DOCS = "docs/README.md:3: The authentication flow is documented here."

describe("M1 — model-equivalent agent via read/grep/glob only (spec §155, plan §6 M1)", () => {
  describe("scenario 1 — semantic grep resolves through the real graph (INTELLIGENCE)", () => {
    test("a grep whose pattern is relationship language gets the graph's caller answer, storage untouched", async () => {
      await using tmp = await tmpdir()
      const input = call("grep", { pattern: "who calls AuthManager" })

      // The leaf alone finds nothing: the phrase "who calls AuthManager" does
      // not appear in any fixture file.
      const baseline = await settleFor(tmp, baselineLayer, input)
      expect(baseline.result).toEqual({ type: "text", value: "No matches found" })

      // Default install: the RulesRouter routes the relationship grep to
      // INTELLIGENCE and the REAL graph answers "who calls AuthManager" with
      // the caller row — a path:line:name only the codegraph could produce.
      const settled = await settleFor(tmp, defaultInstallLayer, input)
      expect(settled.result).toEqual({ type: "text", value: EXPECTED_CALLERS_TEXT })
      const callerText = settled.result.type === "text" ? settled.result.value : ""
      expect(callerText).toContain("src/server.ts")
      expect(callerText).toContain("handleRequest")
      // Storage/TUI output is the raw leaf result — substitution is
      // model-facing only (bounded.output untouched).
      expect(settled.output?.structured).toEqual({ text: "No matches found" })
      // No codegraph-specific tool was ever executed: only `grep` was
      // registered and settled, yet the model-facing answer is graph-derived.
    })
  })

  describe("scenario 2 — hard negative stays DIRECT and byte-identical", () => {
    test("a docs-scoped text grep routes DIRECT and equals the gateway-absent run exactly", async () => {
      await using tmp = await tmpdir()
      const input = call("grep", { pattern: "authentication flow", path: "docs" })

      const baseline = await settleFor(tmp, baselineLayer, input)
      const settled = await settleFor(tmp, defaultInstallLayer, input)

      // Same leaf, same raw output — the docs-scope signal (spec §121/§128)
      // keeps the text index in charge.
      expect(settled).toEqual(baseline)
      expect(settled.result).toEqual({ type: "text", value: EXPECTED_GREP_DOCS })
      expect(settled.output?.structured).toEqual({ text: EXPECTED_GREP_DOCS })
    })
  })

  describe("scenario 3 — read behavior", () => {
    test("3a: an exact-content read stays DIRECT in the default install (byte-identical)", async () => {
      await using tmp = await tmpdir()
      const input = call("read", { path: "src/auth.ts" })

      const baseline = await settleFor(tmp, baselineLayer, input)
      const settled = await settleFor(tmp, defaultInstallLayer, input)

      expect(settled).toEqual(baseline)
      expect(settled.result).toEqual({
        type: "json",
        value: { type: "text-page", content: AUTH_SRC, mime: "text/plain", offset: 1, truncated: false },
      })
    })

    test("3b: with the augment route signal, the REAL graph prefixes a symbol header; storage untouched", async () => {
      await using tmp = await tmpdir()
      const input = call("read", { path: "src/auth.ts" })

      const baseline = await settleFor(tmp, baselineLayer, input)
      const settled = await settleFor(tmp, augmentInstallLayer, input)

      // Model-facing page: graph-derived header prepended, exact source below.
      expect(settled.result).toEqual({
        type: "json",
        value: {
          type: "text-page",
          content: `${EXPECTED_AUGMENT_HEADER}\n${AUTH_SRC}`,
          mime: "text/plain",
          offset: 1,
          truncated: false,
        },
      })
      const pageContent = settled.result.type === "json"
        ? (settled.result.value as { content?: string }).content ?? ""
        : ""
      expect(pageContent.startsWith(EXPECTED_AUGMENT_HEADER)).toBe(true)
      expect(pageContent).toContain("export class AuthManager")
      // Storage/TUI output is the raw page — the header is model-facing only.
      expect(settled.output?.structured).toEqual(baseline.output?.structured)
      expect(settled.output?.structured).toEqual({
        type: "text-page",
        content: AUTH_SRC,
        mime: "text/plain",
        offset: 1,
        truncated: false,
      })
    })
  })

  describe("scenario 4 — opt-out install is byte-identical to the gateway-absent run", () => {
    test("with banyancode_router: \"off\", grep/read/glob settle exactly as without the gateway", async () => {
      await using tmp = await tmpdir()
      const inputs = [
        call("grep", { pattern: "who calls AuthManager" }),
        call("read", { path: "src/auth.ts" }),
        call("glob", { pattern: "*.ts", path: "src" }),
      ]

      const baseline = await settleAllFor(tmp, baselineLayer, inputs)
      const settled = await settleAllFor(tmp, offInstallLayer, inputs)

      expect(settled).toEqual(baseline)
      // The graph answer is NOT substituted on the opt-out install — the
      // relationship grep returns the leaf's empty result, not the caller row.
      expect(settled[0]?.result).toEqual({ type: "text", value: "No matches found" })
      expect(settled[1]?.result).toEqual({
        type: "json",
        value: { type: "text-page", content: AUTH_SRC, mime: "text/plain", offset: 1, truncated: false },
      })
      expect(settled[2]?.result).toEqual({ type: "text", value: "src/auth.ts\nsrc/server.ts" })
    })
  })
})
