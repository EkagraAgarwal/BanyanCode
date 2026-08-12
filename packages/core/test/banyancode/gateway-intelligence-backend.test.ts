import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as BanyanConfigService } from "../../src/banyancode/banyan-config"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import { ToolRouterService, RulesRouter } from "../../src/banyancode/gateway/router"
import type { ToolRouter } from "../../src/banyancode/gateway/types"
import { Service as RepositoryIntelligence } from "../../src/banyancode/repository-intelligence"
import type { Interface as RepositoryIntelligenceInterface } from "../../src/banyancode/repository-intelligence"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

// Known graph rows returned by the RepositoryIntelligence double. The backend
// maps CodegraphNode -> RepositoryResultItem via the file table carried in
// ctx.files, so every item must resolve to a real path.
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

// RepositoryIntelligence double: query/slice are the only methods the backend
// touches; the rest are inert stubs satisfying the interface.
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

// Test runtime: gateway wired to a specific ToolRouter + the intel double.
const withRouterAndIntel = (router: ToolRouter) =>
  testEffect(
    Layer.provideMerge(
      RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, router))),
      intelDouble,
    ),
  )

// Gateway with the RulesRouter but NO RepositoryIntelligence service in scope.
const gatewayWithoutIntel = testEffect(
  RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, RulesRouter))),
)

// Router doubles for exercising specific decision shapes.
const contentRouter: ToolRouter = {
  classify: () =>
    Effect.succeed({
      route: "intelligence" as const,
      operation: { kind: "content" as const, path: "src/foo.ts" },
      confidence: 0.9,
      reasonCodes: ["test"],
    }),
}
const extensionsRouter: ToolRouter = {
  classify: () =>
    Effect.succeed({
      route: "intelligence" as const,
      operation: { kind: "relationship" as const, relation: "extensions" as const, target: "Foo" },
      confidence: 0.9,
      reasonCodes: ["relationship-language"],
      router: "rules",
      routerVersion: "0.1.0",
    }),
}
const symbolRouter: ToolRouter = {
  classify: () =>
    Effect.succeed({
      route: "intelligence" as const,
      operation: { kind: "symbol" as const, query: "AuthManager" },
      confidence: 0.9,
      reasonCodes: ["relationship-language"],
      router: "rules",
      routerVersion: "0.1.0",
    }),
}

// Degraded RepositoryIntelligence double: the graph has no matching symbol.
const degradedIntel: Layer.Layer<RepositoryIntelligence, never, never> = Layer.mock(RepositoryIntelligence, {
  query: () =>
    Effect.succeed({
      status: "failed" as const,
      reason: "No symbol matched",
      query: "Nope",
      symbols: [],
      files: [],
      graph: { nodes: [], edges: [] },
      tests: [],
      docs: [],
      configs: [],
      git: { recentCommits: [] as never[], ownership: new Map() },
      ranking: { score: 0, signals: { exact: 0, symbol: 0, graph: 0, git: 0, workspace: 0 } },
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

const gatewayWithDegradedIntel = testEffect(
  Layer.provideMerge(
    RepositoryGateway.layer.pipe(Layer.provide(Layer.succeed(ToolRouterService, RulesRouter))),
    degradedIntel,
  ),
)

// BanyanConfigService doubles for defaultLayer router selection (plan §2.7).
const configWith = (banyancode_router: "off" | "rules" | "needle" | undefined) =>
  Layer.mock(BanyanConfigService, {
    get: () => Effect.succeed({ banyancode_router }),
    getGlobal: () => Effect.succeed({}),
    update: () => Effect.succeed({}),
    updateAgentOverride: () => Effect.succeed({}),
    getAgentOverrides: () => Effect.succeed({}),
    updateAgentPrompt: () => Effect.succeed({}),
  })

// defaultLayer + config saying "rules" + the intel double: the gateway must
// select the RulesRouter and execute the INTELLIGENCE branch.
const gatewayWithConfigRules = testEffect(
  Layer.provideMerge(
    RepositoryGateway.defaultLayer,
    Layer.mergeAll(configWith("rules"), intelDouble),
  ),
)

// defaultLayer + config OFF + the intel double: NoopRouter keeps every request
// DIRECT even though a backend is available.
const gatewayWithConfigOff = testEffect(
  Layer.provideMerge(
    RepositoryGateway.defaultLayer,
    Layer.mergeAll(configWith(undefined), intelDouble),
  ),
)

// defaultLayer with no BanyanConfigService at all: OFF default (plan §78).
const gatewayWithNoConfig = testEffect(Layer.provideMerge(RepositoryGateway.defaultLayer, intelDouble))

describe("RepositoryGateway INTELLIGENCE backend (Phase 2/3)", () => {
  describe("CALLERS operation executes the backend", () => {
    const it = withRouterAndIntel(RulesRouter)
    it.effect("yields an intelligence result with source codegraph and file:line items", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "who calls AuthManager" },
          userRequest: "who calls AuthManager?",
        })
        expect(outcome.route).toBe("intelligence")
        if (outcome.route === "intelligence") {
          expect(outcome.result.source).toBe("codegraph")
          expect(outcome.result.operation).toEqual({
            kind: "relationship",
            relation: "callers",
            target: "AuthManager",
          })
          expect(outcome.result.results).toEqual([
            { path: "src/server.ts", line: 42, name: "handleRequest", kind: "function" },
            { path: "src/routes/auth.ts", line: 17, name: "loginHandler", kind: "function" },
          ])
          expect(outcome.result.provenance.originalTool).toBe("grep")
          expect(outcome.result.provenance.resolvedOperation).toBe("relationship:callers")
          expect(outcome.result.provenance.router).toBe("rules")
          expect(outcome.result.provenance.routerVersion).toBe("0.1.0")
        }
      }),
    )
  })

  describe("fail-closed behavior", () => {
    gatewayWithoutIntel.effect("missing RepositoryIntelligence service -> direct (fall through)", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "who calls AuthManager" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )

    withRouterAndIntel(contentRouter).effect("backend that does not support an op -> direct", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "read",
          arguments: { path: "src/foo.ts" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )

    withRouterAndIntel(extensionsRouter).effect("unmapped relation (extensions) -> direct (never fabricate)", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "subclasses of Foo" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )

    gatewayWithDegradedIntel.effect("degraded graph (query status failed) -> direct", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "who calls Nope" },
        })
        expect(outcome.route).toBe("direct")
      }),
    )
  })

  describe("SYMBOL operations execute the backend", () => {
    withRouterAndIntel(symbolRouter).effect("symbol op yields symbol items with resolved paths", () =>
      Effect.gen(function* () {
        const gateway = yield* RepositoryGateway.Service
        const outcome = yield* gateway.execute({
          source: "model-tool",
          originalTool: "grep",
          arguments: { pattern: "AuthManager definition" },
        })
        expect(outcome.route).toBe("intelligence")
        if (outcome.route === "intelligence") {
          expect(outcome.result.source).toBe("codegraph")
          expect(outcome.result.results).toEqual([
            { path: "src/server.ts", line: 42, name: "handleRequest", kind: "function" },
            { path: "src/routes/auth.ts", line: 17, name: "loginHandler", kind: "function" },
          ])
        }
      }),
    )
  })

  describe("BANYANCODE_ROUTER env override (plan §4)", () => {
    test("env=rules activates the RulesRouter even when config is absent", async () => {
      const prev = process.env.BANYANCODE_ROUTER
      process.env.BANYANCODE_ROUTER = "rules"
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
        expect(outcome.route).toBe("intelligence")
      } finally {
        if (prev === undefined) delete process.env.BANYANCODE_ROUTER
        else process.env.BANYANCODE_ROUTER = prev
      }
    })
  })
})
