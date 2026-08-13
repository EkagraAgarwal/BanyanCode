import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Service as BanyanConfigService } from "../../src/banyancode/banyan-config"
import { RepositoryGateway, RepositoryGatewayAugment } from "../../src/banyancode/gateway"
import { ToolRouterService } from "../../src/banyancode/gateway/router"
import type { RepositoryRequest, RouterInput } from "../../src/banyancode/gateway/types"
import { Service as RepositoryIntelligence } from "../../src/banyancode/repository-intelligence"
import type { Interface as RepositoryIntelligenceInterface } from "../../src/banyancode/repository-intelligence"
import { BanyanConfig } from "../../src/v1/config/banyan-config"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { settleTool } from "../lib/tool"

process.env.BANYANCODE_ENABLE = "1"

// Known graph rows returned by the RepositoryIntelligence double (same shape
// as gateway-intelligence-backend.test.ts): the CALLERS operation must resolve
// to real file:line items.
const fileA = { id: "file-a", path: "src/server.ts", contentHash: "h", language: "typescript", indexedAt: 0 }
const fileB = { id: "file-b", path: "src/routes/auth.ts", contentHash: "h", language: "typescript", indexedAt: 0 }
const callerA = { id: "n-a", fileID: "file-a", kind: "function" as const, name: "handleRequest", startLine: 42, endLine: 60 }
const callerB = { id: "n-b", fileID: "file-b", kind: "function" as const, name: "loginHandler", startLine: 17, endLine: 30 }

const baseCtx = {
  status: "success" as const,
  query: "AuthManager",
  symbols: [callerA, callerB],
  files: [fileA, fileB],
  graph: { nodes: [callerA, callerB], edges: [] },
  tests: [],
  docs: [],
  configs: [],
  git: { recentCommits: [] as never[], ownership: new Map() },
  ranking: { score: 0, signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 } },
}

const sliceResult = {
  status: "success" as const,
  summary: "Query AuthManager",
  entrypoints: [callerA],
  importantSymbols: [callerA, callerB],
  relatedTests: [],
  relatedDocs: [],
  configs: [],
  routes: [],
  dependencies: [],
  directCallers: [callerA, callerB],
  transitiveDependents: [],
}

const intelDouble: Layer.Layer<RepositoryIntelligence, never, never> = Layer.mock(RepositoryIntelligence, {
  query: ({ query }) => Effect.succeed({ ...baseCtx, query }),
  slice: () => Effect.succeed(sliceResult),
  explain: ({ symbol }) => Effect.succeed({ ...sliceResult, summary: symbol }),
  impact: () => Effect.succeed(sliceResult),
  trace: () => Effect.succeed(sliceResult),
  tests: () => Effect.succeed({ tests: [], notFound: false, derivation: "none" }),
  symbols: () => Effect.succeed([callerA, callerB]),
  relationships: () => Effect.succeed([callerA, callerB]),
  findOwner: () => Effect.succeed({ count: 0 }),
} satisfies RepositoryIntelligenceInterface)

// BanyanConfigService double: `get` returns the given flags, everything else
// inert.
const configWith = (flags: Partial<BanyanConfig.Info>) =>
  Layer.mock(BanyanConfigService, {
    get: () => Effect.succeed(flags),
    getGlobal: () => Effect.succeed({}),
    update: () => Effect.succeed({}),
    updateAgentOverride: () => Effect.succeed({}),
    getAgentOverrides: () => Effect.succeed({}),
    updateAgentPrompt: () => Effect.succeed({}),
  })

describe("defaultLayer router selection (plan §4 — ON by default)", () => {
  const withDefaultNoConfig = testEffect(Layer.provideMerge(RepositoryGateway.defaultLayer, intelDouble))

  withDefaultNoConfig.effect("no config, no env -> RulesRouter: relationship grep resolves INTELLIGENCE", () =>
    Effect.gen(function* () {
      const saved = process.env.BANYANCODE_ROUTER
      delete process.env.BANYANCODE_ROUTER
      try {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "who calls AuthManager" },
          userRequest: "who calls AuthManager?",
        })
        expect(outcome.route).toBe("intelligence")
        if (outcome.route === "intelligence") {
          expect(outcome.result.provenance.router).toBe("rules")
          expect(outcome.result.provenance.resolvedOperation).toBe("relationship:callers")
          expect(outcome.result.results).toEqual([
            { path: "src/server.ts", line: 42, name: "handleRequest", kind: "function" },
            { path: "src/routes/auth.ts", line: 17, name: "loginHandler", kind: "function" },
          ])
        }
      } finally {
        if (saved === undefined) delete process.env.BANYANCODE_ROUTER
        else process.env.BANYANCODE_ROUTER = saved
      }
    }),
  )

  test("env BANYANCODE_ROUTER=off still resolves the NoopRouter (opt-out works)", async () => {
    const saved = process.env.BANYANCODE_ROUTER
    process.env.BANYANCODE_ROUTER = "off"
    try {
      const outcome = await Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        return yield* gateway.execute({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "who calls AuthManager" },
          userRequest: "who calls AuthManager?",
        })
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(RepositoryGateway.defaultLayer, intelDouble)),
        Effect.runPromise,
      )
      expect(outcome.route).toBe("direct")
    } finally {
      if (saved === undefined) delete process.env.BANYANCODE_ROUTER
      else process.env.BANYANCODE_ROUTER = saved
    }
  })
})

describe("augmentEnabled default (plan §4 — ON by default)", () => {
  const noConfig = testEffect(Layer.empty)
  noConfig.effect("true without a BanyanConfigService", () =>
    Effect.gen(function* () {
      expect(yield* RepositoryGatewayAugment.augmentEnabled()).toBe(true)
    }),
  )

  const withFlag = (flag: boolean | undefined) => testEffect(configWith({ banyancode_augment_read: flag }))
  withFlag(false).effect("false with an explicit banyancode_augment_read: false", () =>
    Effect.gen(function* () {
      expect(yield* RepositoryGatewayAugment.augmentEnabled()).toBe(false)
    }),
  )
  withFlag(true).effect("true with an explicit banyancode_augment_read: true", () =>
    Effect.gen(function* () {
      expect(yield* RepositoryGatewayAugment.augmentEnabled()).toBe(true)
    }),
  )
  withFlag(undefined).effect("true when the flag is unset", () =>
    Effect.gen(function* () {
      expect(yield* RepositoryGatewayAugment.augmentEnabled()).toBe(true)
    }),
  )
})

describe("INTELLIGENCE substitution in ToolRegistry.settleWith (plan §4)", () => {
  const outputStore = Layer.mock(ToolOutputStore.Service, {
    bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
  })
  const registryLayer = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))

  const gatewayCalls: RepositoryRequest[] = []
  const intelOutcome: RepositoryGateway.GatewayOutcome = {
    route: "intelligence",
    result: {
      route: "intelligence",
      operation: { kind: "relationship", relation: "callers", target: "AuthManager" },
      source: "codegraph",
      results: [
        { path: "src/server.ts", line: 42, name: "handleRequest", kind: "function" },
        { path: "src/routes/auth.ts", line: 17, name: "loginHandler", kind: "function" },
      ],
      provenance: {
        originalTool: "grep",
        resolvedOperation: "relationship:callers",
        router: "rules",
        routerVersion: "0.1.0",
      },
    },
  }
  const intelligenceGateway = Layer.mock(RepositoryGateway.Service, {
    execute: (request) =>
      Effect.sync(() => {
        gatewayCalls.push(request)
        return intelOutcome
      }),
  })
  const withSubstitution = testEffect(Layer.provideMerge(registryLayer, intelligenceGateway))

  const identity = {
    agent: AgentV2.ID.make("build"),
    assistantMessageID: SessionMessage.ID.make("msg_defaults"),
  }
  const sessionID = SessionV2.ID.make("ses_defaults")
  const call = (name: string): ToolRegistry.ExecuteInput => ({
    sessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${name}`, name, input: { text: name } },
  })

  const make = (name: string) =>
    Tool.make({
      description: `${name} probe`,
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
      execute: ({ text }) => Effect.succeed({ text: `${name}:${text}` }),
      toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
    })

  // json-shaped probe: toModelOutput returns [] so the settlement is
  // { type: "json", value: <text-page> }.
  const jsonProbe = Tool.make({
    description: "grep probe (json result)",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({
      type: Schema.Literal("text-page"),
      content: Schema.String,
      mime: Schema.String,
      offset: Schema.Number,
      truncated: Schema.Boolean,
    }),
    execute: () =>
      Effect.succeed({
        type: "text-page" as const,
        content: "line one",
        mime: "text/plain",
        offset: 1,
        truncated: false,
      }),
    toModelOutput: () => [],
  })

  withSubstitution.effect("grep settle: model-facing result is the rendered intelligence text, storage output untouched", () =>
    Effect.gen(function* () {
      gatewayCalls.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ grep: make("grep"), read: make("read") })
      const settled = yield* settleTool(service, call("grep"))
      expect(settled.result).toEqual({
        type: "text",
        value: "AuthManager callers:\n\nsrc/server.ts:42 (handleRequest)\nsrc/routes/auth.ts:17 (loginHandler)",
      })
      // Storage/TUI output is untouched: substitution is model-facing only.
      expect(settled.output?.structured).toEqual({ text: "grep:grep" })
      expect(gatewayCalls.at(-1)?.originalTool).toBe("grep")
    }),
  )

  withSubstitution.effect("a json settlement is substituted too (type becomes text)", () =>
    Effect.gen(function* () {
      gatewayCalls.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ grep: jsonProbe })
      const settled = yield* settleTool(service, call("grep"))
      expect(settled.result).toEqual({
        type: "text",
        value: "AuthManager callers:\n\nsrc/server.ts:42 (handleRequest)\nsrc/routes/auth.ts:17 (loginHandler)",
      })
      expect(settled.output?.structured).toEqual({
        type: "text-page",
        content: "line one",
        mime: "text/plain",
        offset: 1,
        truncated: false,
      })
    }),
  )

  const directGateway = Layer.mock(RepositoryGateway.Service, {
    execute: (request) =>
      Effect.sync(() => {
        gatewayCalls.push(request)
        return { route: "direct" as const }
      }),
  })
  const withDirect = testEffect(Layer.provideMerge(registryLayer, directGateway))

  withDirect.effect("a DIRECT outcome leaves the settle byte-identical", () =>
    Effect.gen(function* () {
      gatewayCalls.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ grep: make("grep") })
      const settled = yield* settleTool(service, call("grep"))
      expect(settled).toEqual({
        result: { type: "text", value: "grep:grep" },
        output: {
          structured: { text: "grep:grep" },
          content: [{ type: "text", text: "grep:grep" }],
        },
      })
    }),
  )

  withSubstitution.effect("a non-listed tool (bash) is never substituted", () =>
    Effect.gen(function* () {
      gatewayCalls.length = 0
      const service = yield* ToolRegistry.Service
      yield* service.register({ bash: make("bash") })
      const settled = yield* settleTool(service, call("bash"))
      expect(settled.result).toEqual({ type: "text", value: "bash:bash" })
      expect(gatewayCalls.length).toBe(0)
    }),
  )
})

describe("per-tool routing kill-switches (plan §4)", () => {
  const outputStore = Layer.mock(ToolOutputStore.Service, {
    bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
  })
  const registryLayer = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))

  const routerCalls: RouterInput[] = []
  const recordingRouter = Layer.succeed(
    ToolRouterService,
    ToolRouterService.of({
      classify: (input) =>
        Effect.sync(() => {
          routerCalls.push(input)
          return { route: "direct" as const, confidence: 1, reasonCodes: ["recording"] }
        }),
    }),
  )
  const gatewayWithGrepOff = Layer.provideMerge(
    RepositoryGateway.layer.pipe(Layer.provide(recordingRouter)),
    configWith({ banyancode_route_grep: false }),
  )
  const withGrepOff = testEffect(Layer.provideMerge(registryLayer, gatewayWithGrepOff))

  const identity = {
    agent: AgentV2.ID.make("build"),
    assistantMessageID: SessionMessage.ID.make("msg_killswitch"),
  }
  const sessionID = SessionV2.ID.make("ses_killswitch")
  const call = (name: string): ToolRegistry.ExecuteInput => ({
    sessionID,
    ...identity,
    call: { type: "tool-call", id: `call-${name}`, name, input: { text: name } },
  })

  const make = (name: string) =>
    Tool.make({
      description: `${name} probe`,
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
      execute: ({ text }) => Effect.succeed({ text: `${name}:${text}` }),
      toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
    })

  const registerProbes = (service: ToolRegistry.Interface) =>
    service.register({ read: make("read"), grep: make("grep"), glob: make("glob") })

  withGrepOff.effect("grep with banyancode_route_grep: false skips the gateway entirely (zero router calls)", () =>
    Effect.gen(function* () {
      routerCalls.length = 0
      const service = yield* ToolRegistry.Service
      yield* registerProbes(service)
      const settled = yield* settleTool(service, call("grep"))
      expect(settled).toEqual({
        result: { type: "text", value: "grep:grep" },
        output: {
          structured: { text: "grep:grep" },
          content: [{ type: "text", text: "grep:grep" }],
        },
      })
      expect(routerCalls.length).toBe(0)
    }),
  )

  withGrepOff.effect("read is still routed when only the grep flag is false", () =>
    Effect.gen(function* () {
      routerCalls.length = 0
      const service = yield* ToolRegistry.Service
      yield* registerProbes(service)
      const settled = yield* settleTool(service, call("read"))
      expect(settled.result).toEqual({ type: "text", value: "read:read" })
      expect(routerCalls.length).toBe(1)
      expect(routerCalls.at(-1)?.toolName).toBe("read")
    }),
  )
})

describe("router_trace gating (plan §4 — off by default)", () => {
  const testDoubleRouter = ToolRouterService.of({
    classify: () =>
      Effect.succeed({
        route: "direct" as const,
        confidence: 1,
        reasonCodes: ["test-double"],
        router: "test-double",
        routerVersion: "1.0.0",
      }),
  })
  const gatewayLayer = RepositoryGateway.layer.pipe(
    Layer.provide(Layer.succeed(ToolRouterService, testDoubleRouter)),
  )

  // Execute one routed request against a tmpdir worktree and report whether
  // the per-session trace file was written.
  const traceWritten = (layer: Layer.Layer<RepositoryGateway.Service, never, never>) =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const gateway = yield* RepositoryGateway.Service
      yield* gateway.execute({
        source: "model-tool",
        sessionID: "trace-gate-session",
        originalTool: "grep",
        arguments: { pattern: "AuthManager" },
        repositoryContext: { root: dir.path, graphStatus: "fresh", supportedLanguages: [] },
      })
      const file = path.join(dir.path, ".banyancode", "trace", "trace-gate-session.jsonl")
      return yield* Effect.promise(() =>
        readFile(file, "utf8").then(
          () => true,
          () => false,
        ),
      )
    }).pipe(Effect.provide(layer))

  const withTraceOffLayer = Layer.provideMerge(gatewayLayer, configWith({ banyancode_router_trace: false }))
  const withTraceOff = testEffect(withTraceOffLayer)
  withTraceOff.effect("explicit banyancode_router_trace: false -> no trace file", () =>
    Effect.gen(function* () {
      expect(yield* traceWritten(withTraceOffLayer)).toBe(false)
    }),
  )

  const noConfig = testEffect(gatewayLayer)
  noConfig.effect("no config service -> no trace file", () =>
    Effect.gen(function* () {
      expect(yield* traceWritten(gatewayLayer)).toBe(false)
    }),
  )

  const withTraceOnLayer = Layer.provideMerge(gatewayLayer, configWith({ banyancode_router_trace: true }))
  const withTraceOn = testEffect(withTraceOnLayer)
  withTraceOn.effect("banyancode_router_trace: true -> trace file written", () =>
    Effect.gen(function* () {
      expect(yield* traceWritten(withTraceOnLayer)).toBe(true)
    }),
  )

  withTraceOn.effect("env BANYANCODE_ROUTER_TRACE=true emits even without config", () =>
    Effect.gen(function* () {
      const saved = process.env.BANYANCODE_ROUTER_TRACE
      process.env.BANYANCODE_ROUTER_TRACE = "true"
      try {
        expect(yield* traceWritten(gatewayLayer)).toBe(true)
      } finally {
        if (saved === undefined) delete process.env.BANYANCODE_ROUTER_TRACE
        else process.env.BANYANCODE_ROUTER_TRACE = saved
      }
    }),
  )
})
