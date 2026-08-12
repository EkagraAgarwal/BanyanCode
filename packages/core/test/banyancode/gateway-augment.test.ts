import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Service as BanyanConfigService } from "../../src/banyancode/banyan-config"
import { RepositoryGateway, RepositoryGatewayAugment, RepositoryGatewayFormatter } from "../../src/banyancode/gateway"
import { ToolRouterService } from "../../src/banyancode/gateway/router"
import type { ToolRouter } from "../../src/banyancode/gateway/types"
import { RepositoryIntelligence } from "../../src/banyancode/repository-intelligence"
import type { Interface as RepositoryIntelligenceInterface } from "../../src/banyancode/repository-intelligence"
import { testEffect } from "../lib/effect"
import { settleTool } from "../lib/tool"

process.env.BANYANCODE_ENABLE = "1"

// Known graph rows returned by the RepositoryIntelligence double. The augment
// path queries with the file's basename stem, then resolves the FILE's main
// symbol by matching ctx.files paths against the requested content path, and
// derives the header counts from the slice fixture + ctx.graph edges.
const fileA = { id: "file-a", path: "src/server.ts", contentHash: "h", language: "typescript", indexedAt: 0 }
const fileB = { id: "file-b", path: "src/routes/auth.ts", contentHash: "h", language: "typescript", indexedAt: 0 }
const mainSymbol = { id: "n-main", fileID: "file-a", kind: "class" as const, name: "AuthManager", startLine: 10, endLine: 80 }
const otherSymbol = { id: "n-other", fileID: "file-b", kind: "function" as const, name: "loginHandler", startLine: 17, endLine: 30 }
const callerA = { id: "n-a", fileID: "file-b", kind: "function" as const, name: "loginHandler", startLine: 17, endLine: 30 }
const transitiveDep = { id: "n-dep", fileID: "file-b", kind: "function" as const, name: "depended", startLine: 50, endLine: 55 }

const baseCtx = {
  status: "success" as const,
  query: "AuthManager",
  symbols: [mainSymbol, otherSymbol],
  files: [fileA, fileB],
  graph: {
    nodes: [mainSymbol, otherSymbol, callerA, transitiveDep],
    edges: [
      { id: "e1", kind: "references" as const, fromNodeID: "n-a", toNodeID: "n-main" },
      { id: "e2", kind: "references" as const, fromNodeID: "n-other", toNodeID: "n-main" },
      { id: "e3", kind: "calls" as const, fromNodeID: "n-a", toNodeID: "n-main" },
      { id: "e4", kind: "imports" as const, fromNodeID: "n-main", toNodeID: "n-other" },
    ],
  },
  tests: [],
  docs: [],
  configs: [],
  git: { recentCommits: [] as never[], ownership: new Map() },
  ranking: { score: 0, signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 } },
}

// Slice fixture the header builder derives Imports / Callers / Dependents
// counts from; References comes from ctx.graph.edges (kind "references").
const sliceResult = {
  status: "success" as const,
  summary: "Query AuthManager",
  entrypoints: [mainSymbol],
  importantSymbols: [mainSymbol, otherSymbol],
  relatedTests: [],
  relatedDocs: [],
  configs: [],
  routes: [],
  dependencies: [{ name: "TokenService" }, { name: "UserRepository" }],
  directCallers: [callerA, otherSymbol],
  transitiveDependents: [transitiveDep],
}

// Expected header for path "src/server.ts": Symbol AuthManager (class in the
// requested file), Imports 2, References 2 (e1/e2), Callers 2, Dependents 1.
const EXPECTED_HEADER = "Symbol: AuthManager | Imports: 2 | References: 2 | Callers: 2 | Dependents: 1"

const intelDouble: Layer.Layer<RepositoryIntelligence.Service, never, never> = Layer.mock(RepositoryIntelligence.Service, {
  query: ({ query }) => Effect.succeed({ ...baseCtx, query }),
  slice: () => Effect.succeed(sliceResult),
  explain: ({ symbol }) => Effect.succeed({ ...sliceResult, summary: symbol }),
  impact: () => Effect.succeed(sliceResult),
  trace: () => Effect.succeed(sliceResult),
  tests: () => Effect.succeed({ tests: [], notFound: false, derivation: "none" }),
  symbols: () => Effect.succeed([mainSymbol, otherSymbol]),
  relationships: () => Effect.succeed([mainSymbol, otherSymbol]),
  findOwner: () => Effect.succeed({ count: 0 }),
} satisfies RepositoryIntelligenceInterface)

// Degraded graph: query() reports no matching symbol -> fail closed.
const degradedIntel: Layer.Layer<RepositoryIntelligence.Service, never, never> = Layer.mock(RepositoryIntelligence.Service, {
  query: () =>
    Effect.succeed({
      ...baseCtx,
      status: "failed" as const,
      reason: "No symbol matched",
      query: "server",
      symbols: [],
      graph: { nodes: [], edges: [] },
    }),
  slice: () => Effect.succeed(sliceResult),
  explain: () => Effect.succeed(sliceResult),
  impact: () => Effect.succeed(sliceResult),
  trace: () => Effect.succeed(sliceResult),
  tests: () => Effect.succeed({ tests: [], notFound: true, derivation: "none" }),
  symbols: () => Effect.succeed([]),
  relationships: () => Effect.succeed([]),
  findOwner: () => Effect.succeed({ count: 0 }),
} satisfies RepositoryIntelligenceInterface)

// Defect inside the graph path (slice dies): the backend must swallow it and
// fail closed to DIRECT — never throw.
const throwingIntel: Layer.Layer<RepositoryIntelligence.Service, never, never> = Layer.mock(RepositoryIntelligence.Service, {
  query: ({ query }) => Effect.succeed({ ...baseCtx, query }),
  slice: () => Effect.die("slice boom"),
  explain: () => Effect.succeed(sliceResult),
  impact: () => Effect.succeed(sliceResult),
  trace: () => Effect.succeed(sliceResult),
  tests: () => Effect.succeed({ tests: [], notFound: false, derivation: "none" }),
  symbols: () => Effect.succeed([mainSymbol]),
  relationships: () => Effect.succeed([mainSymbol]),
  findOwner: () => Effect.succeed({ count: 0 }),
} satisfies RepositoryIntelligenceInterface)

// BanyanConfigService doubles for the augment gate (spec §77/§117).
const configWith = (banyancode_augment_read: boolean | undefined) =>
  Layer.mock(BanyanConfigService, {
    get: () => Effect.succeed({ banyancode_augment_read }),
    getGlobal: () => Effect.succeed({}),
    update: () => Effect.succeed({}),
    updateAgentOverride: () => Effect.succeed({}),
    getAgentOverrides: () => Effect.succeed({}),
    updateAgentPrompt: () => Effect.succeed({}),
  })

// Router doubles. augmentRouter emits an "augment" RouteDecision for a content
// read (the future RulesRouter-variant signal); augmentOnContentViaIntel
// emits "intelligence" on a content op, which the augment backend also
// answers (reachability path 2); augmentConfigRouter reads a config file.
const augmentRouter: ToolRouter = {
  classify: () =>
    Effect.succeed({
      route: "augment" as const,
      operation: { kind: "content" as const, path: "src/server.ts" },
      confidence: 1,
      reasonCodes: ["test"],
      router: "rules",
      routerVersion: "0.1.0",
    }),
}
const augmentOnContentViaIntel: ToolRouter = {
  classify: () =>
    Effect.succeed({
      route: "intelligence" as const,
      operation: { kind: "content" as const, path: "src/server.ts" },
      confidence: 0.9,
      reasonCodes: ["test"],
    }),
}
const augmentConfigRouter: ToolRouter = {
  classify: () =>
    Effect.succeed({
      route: "augment" as const,
      operation: { kind: "content" as const, path: "package.json" },
      confidence: 1,
      reasonCodes: ["test"],
    }),
}

// Gateway with a specific router + the intel double, config gate ON.
const withAugment = (router: ToolRouter, intel: Layer.Layer<RepositoryIntelligence.Service, never, never> = intelDouble) =>
  testEffect(
    Layer.provideMerge(
      RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, router))),
      Layer.mergeAll(intel, configWith(true)),
    ),
  )

// Config gate OFF (explicit false) and no config service at all.
const withAugmentGateOff = (router: ToolRouter) =>
  testEffect(
    Layer.provideMerge(
      RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, router))),
      Layer.mergeAll(intelDouble, configWith(false)),
    ),
  )
const withAugmentNoConfig = (router: ToolRouter) =>
  testEffect(
    Layer.provideMerge(
      RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, router))),
      intelDouble,
    ),
  )

describe("RepositoryGateway AUGMENT (Phase 7)", () => {
  describe("augment decision with the config gate on", () => {
    withAugment(augmentRouter).effect("yields { route: augment, header } with slice-derived counts", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "src/server.ts" },
        })
        expect(outcome.route).toBe("augment")
        if (outcome.route === "augment") {
          expect(outcome.header).toBe(EXPECTED_HEADER)
          expect(outcome.header).toContain("Symbol: AuthManager")
          expect(outcome.header).toContain("Imports: 2")
          expect(outcome.header).toContain("References: 2")
          expect(outcome.header).toContain("Callers: 2")
          expect(outcome.header).toContain("Dependents: 1")
          // Result is the graph-derived internal payload; provenance is
          // stamped from the request + decision (spec §43, §60).
          expect(outcome.result.route).toBe("augment")
          expect(outcome.result.source).toBe("codegraph")
          expect(outcome.result.operation).toEqual({ kind: "content", path: "src/server.ts" })
          expect(outcome.result.results).toEqual([])
          expect(outcome.result.header).toBe(EXPECTED_HEADER)
          expect(outcome.result.provenance.originalTool).toBe("read")
          expect(outcome.result.provenance.resolvedOperation).toBe("content")
          expect(outcome.result.provenance.router).toBe("rules")
          expect(outcome.result.provenance.routerVersion).toBe("0.1.0")
        }
      }),
    )

    withAugment(augmentOnContentViaIntel).effect(
      "an intelligence decision on a content op also yields augment",
      () =>
        Effect.gen(function* () {
          const gateway = yield* RepositoryGateway.Service
          const outcome = yield* gateway.execute({
            source: "model-tool",
            originalTool: "read",
            arguments: { path: "src/server.ts" },
          })
          expect(outcome.route).toBe("augment")
          if (outcome.route === "augment") {
            expect(outcome.header).toContain("Symbol: AuthManager")
          }
        }),
    )
  })

  describe("fail-closed behavior (spec §35)", () => {
    withAugment(augmentConfigRouter).effect("non-code path (config file) -> direct, no augment", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "package.json" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )

    withAugmentGateOff(augmentRouter).effect("config gate off -> augment never engages even with the decision", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "src/server.ts" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )

    withAugmentNoConfig(augmentRouter).effect("no BanyanConfigService -> augment never engages (default off)", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "src/server.ts" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )

    withAugment(augmentRouter, degradedIntel).effect("degraded graph (query status failed) -> direct, no augment", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "src/server.ts" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )

    withAugment(augmentRouter, throwingIntel).effect("defect inside the graph path never throws -> direct", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "src/server.ts" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )
  })

  describe("symbolHeaderFor (unit)", () => {
    const itIntel = testEffect(intelDouble)
    itIntel.effect("builds header + augment result for a code file path", () =>
      Effect.gen(function* () {
        const intel = yield* RepositoryIntelligence.Service
        const built = yield* RepositoryGatewayAugment.symbolHeaderFor("src/server.ts", intel)
        expect(built?.header).toBe(EXPECTED_HEADER)
        expect(built?.result.route).toBe("augment")
        expect(built?.result.source).toBe("codegraph")
        expect(built?.result.operation).toEqual({ kind: "content", path: "src/server.ts" })
      }),
    )

    itIntel.effect("returns undefined for a non-code path (config file)", () =>
      Effect.gen(function* () {
        const intel = yield* RepositoryIntelligence.Service
        const built = yield* RepositoryGatewayAugment.symbolHeaderFor("package.json", intel)
        expect(built).toBeUndefined()
      }),
    )

    itIntel.effect("returns undefined when no symbol lives in the requested file", () =>
      Effect.gen(function* () {
        const intel = yield* RepositoryIntelligence.Service
        const built = yield* RepositoryGatewayAugment.symbolHeaderFor("src/missing.ts", intel)
        expect(built).toBeUndefined()
      }),
    )

    const itDegraded = testEffect(degradedIntel)
    itDegraded.effect("returns undefined on a degraded graph", () =>
      Effect.gen(function* () {
        const intel = yield* RepositoryIntelligence.Service
        const built = yield* RepositoryGatewayAugment.symbolHeaderFor("src/server.ts", intel)
        expect(built).toBeUndefined()
      }),
    )
  })

  describe("formatter", () => {
    const it = testEffect(Layer.empty)
    it.effect("formatAugmentHeader renders one compact line", () =>
      Effect.gen(function* () {
        const line = RepositoryGatewayFormatter.formatAugmentHeader({
          symbol: "AuthManager",
          imports: 1,
          references: 2,
          callers: 3,
          dependents: 4,
        })
        expect(line).toBe("Symbol: AuthManager | Imports: 1 | References: 2 | Callers: 3 | Dependents: 4")
      }),
    )
  })

  describe("registry settle merge (end-to-end through the real gateway, Phase 7)", () => {
    const outputStore = Layer.mock(ToolOutputStore.Service, {
      bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
    })
    const registryLayer = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))
    const withRegistry = testEffect(
      Layer.provideMerge(
        registryLayer,
        Layer.provideMerge(
          RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, augmentRouter))),
          Layer.mergeAll(intelDouble, configWith(true)),
        ),
      ),
    )

    // Page-shaped read probe: `toModelOutput` returns [] so settlement is
    // { type: "json", value: <text-page> } — the shape the merge targets.
    const pageRead = Tool.make({
      description: "read probe (text page)",
      input: Schema.Struct({ path: Schema.String }),
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
          content: "line one\nline two",
          mime: "text/plain",
          offset: 1,
          truncated: false,
        }),
      toModelOutput: () => [],
    })

    withRegistry.effect("augment decision flows through and prefixes the read page content", () =>
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        yield* service.register({ read: pageRead })
        const settled = yield* settleTool(service, {
          sessionID: SessionV2.ID.make("ses_augment_e2e"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_augment_e2e"),
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "src/server.ts" } },
        })
        expect(settled.result).toEqual({
          type: "json",
          value: {
            type: "text-page",
            content: `${EXPECTED_HEADER}\nline one\nline two`,
            mime: "text/plain",
            offset: 1,
            truncated: false,
          },
        })
      }),
    )
  })
})
