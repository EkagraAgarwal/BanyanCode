import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import { ToolRouterService } from "../../src/banyancode/gateway/router"
import type { RepositoryRequest, RouterInput } from "../../src/banyancode/gateway/types"
import { testEffect } from "../lib/effect"
import { settleTool } from "../lib/tool"

process.env.BANYANCODE_ENABLE = "1"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const registry = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))

// Runtime 1 — gateway disabled: no RepositoryGateway in scope, so the
// settleWith hook's `serviceOption` resolves None and the path is byte-for-byte
// the pre-gateway behavior.
const disabled = testEffect(registry)

// Runtime 2 — gateway enabled with the default NoopRouter: every request routes
// DIRECT, so settlement must be identical to Runtime 1 (DIRECT-only invariant,
// plan §2.1).
const enabled = testEffect(Layer.provideMerge(registry, RepositoryGateway.defaultLayer))

// Runtime 3 — gateway with a recording router test double: proves the choke
// point actually consults the gateway (and that a DIRECT outcome falls through
// to the unchanged leaf settle).
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
const consulted = testEffect(
  Layer.provideMerge(registry, RepositoryGateway.layer.pipe(Layer.provide(recordingRouter))),
)

// Runtime 4 — gateway with a recording router that resolves INTELLIGENCE: the
// gateway executes the (missing) backend -> fail-closed direct outcome, which
// the registry discards. Observable tool behavior must be unchanged (Phase 2
// contract — the original leaf settle always runs).
const intelRouterCalls: RouterInput[] = []
const intelligenceRouter = Layer.succeed(
  ToolRouterService,
  ToolRouterService.of({
    classify: (input) =>
      Effect.sync(() => {
        intelRouterCalls.push(input)
        return {
          route: "intelligence" as const,
          operation: { kind: "relationship" as const, relation: "callers" as const, target: "Foo" },
          confidence: 0.9,
          reasonCodes: ["relationship-language"],
          router: "rules",
          routerVersion: "0.1.0",
        }
      }),
  }),
)
const intelligenceConsulted = testEffect(
  Layer.provideMerge(registry, RepositoryGateway.layer.pipe(Layer.provide(intelligenceRouter))),
)

// Runtime 5 — gateway double that records calls and resolves AUGMENT (Phase 7,
// spec §6.2/§29/§117). `execute` returns the outcome directly (mirrors the
// router+backend outcome shape), so the merge contract in settleWith is tested
// in isolation from the augment backend: the read tool's model-facing page
// content gets the header prepended; grep/glob, non-json, and error
// settlements stay byte-identical.
const gatewayCalls: RepositoryRequest[] = []
const augmentOutcome: RepositoryGateway.GatewayOutcome = {
  route: "augment",
  header: "Symbol: Foo | Imports: 1 | References: 2 | Callers: 2 | Dependents: 1",
  result: {
    route: "augment",
    operation: { kind: "content", path: "src/foo.ts" },
    source: "codegraph",
    results: [],
    header: "Symbol: Foo | Imports: 1 | References: 2 | Callers: 2 | Dependents: 1",
    provenance: { originalTool: "read", resolvedOperation: "content", router: "rules", routerVersion: "0.1.0" },
  },
}
const augmentGateway = Layer.mock(RepositoryGateway.Service, {
  execute: (request) =>
    Effect.sync(() => {
      gatewayCalls.push(request)
      return augmentOutcome
    }),
})
const augmentConsulted = testEffect(Layer.provideMerge(registry, augmentGateway))

// Runtime 6 — same double resolving DIRECT: the merge must not fire.
const directGateway = Layer.mock(RepositoryGateway.Service, {
  execute: (request) =>
    Effect.sync(() => {
      gatewayCalls.push(request)
      return { route: "direct" as const }
    }),
})
const directConsulted = testEffect(Layer.provideMerge(registry, directGateway))

const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_gateway"),
}
const sessionID = SessionV2.ID.make("ses_gateway")
const call = (name: string): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}`, name, input: { text: name } },
})

// Canonical echo tools registered under the repository-intelligence names the
// gateway intercepts. The hook sits in settleWith, upstream of leaf internals,
// so leaf shape is irrelevant to the DIRECT-only invariant.
const make = (name: string) =>
  Tool.make({
    description: `${name} probe`,
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text: `${name}:${text}` }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })

// Page-shaped read probe: `toModelOutput` returns [] so settlement is
// { type: "json", value: <text-page> } — the exact shape the AUGMENT merge
// targets (mirrors ReadTool.TextPage, read-filesystem.ts:39-46).
const pageRead = Tool.make({
  description: "read probe (text page)",
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
      content: "line one\nline two",
      mime: "text/plain",
      offset: 1,
      truncated: false,
    }),
  toModelOutput: () => [],
})

// Read probe whose settlement is json but NOT TextPage-shaped (has a `content`
// string but no "text-page" discriminator): the shape guard must skip the merge.
const nonPageRead = Tool.make({
  description: "read probe (non-page json)",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ content: Schema.String, mime: Schema.String }),
  execute: () => Effect.succeed({ content: "raw content", mime: "text/plain" }),
  toModelOutput: () => [],
})

// Read probe that fails with LLM.ToolFailure -> error settlement: the merge
// must leave error results untouched.
const failingRead = Tool.make({
  description: "read probe (fails)",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.fail(new ToolFailure({ message: "boom" })),
  toModelOutput: () => [],
})

const registerProbes = (service: ToolRegistry.Interface) =>
  service.register({ read: make("read"), grep: make("grep"), glob: make("glob") })

describe("RepositoryGateway interception in ToolRegistry.settleWith", () => {
  describe("gateway disabled (serviceOption None)", () => {
    disabled.effect("read/grep/glob settle with the normal result shape", () =>
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        for (const name of ["read", "grep", "glob"] as const) {
          const settled = yield* settleTool(service, call(name))
          expect(settled).toEqual({
            result: { type: "text", value: `${name}:${name}` },
            output: {
              structured: { text: `${name}:${name}` },
              content: [{ type: "text", text: `${name}:${name}` }],
            },
          })
        }
      }),
    )

    disabled.effect("unregistered tools still return the error settlement", () =>
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        const settled = yield* settleTool(service, call("read"))
        expect(settled).toEqual({ result: { type: "error", value: "Unknown tool: read" } })
      }),
    )
  })

  describe("gateway enabled (DIRECT-only invariant)", () => {
    enabled.effect("read/grep/glob settle identically to the disabled case", () =>
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        for (const name of ["read", "grep", "glob"] as const) {
          const settled = yield* settleTool(service, call(name))
          expect(settled).toEqual({
            result: { type: "text", value: `${name}:${name}` },
            output: {
              structured: { text: `${name}:${name}` },
              content: [{ type: "text", text: `${name}:${name}` }],
            },
          })
        }
      }),
    )

    enabled.effect("materialize + settle still works with the gateway in scope", () =>
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        const definitions = yield* service.materialize().pipe(Effect.map((m) => m.definitions))
        expect(definitions.map((d) => d.name)).toEqual(["read", "grep", "glob"])
      }),
    )
  })

  describe("router test double (gateway is consulted)", () => {
    consulted.effect("recording router is invoked and DIRECT falls through unchanged", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        const settled = yield* settleTool(service, call("read"))
        expect(settled).toEqual({
          result: { type: "text", value: "read:read" },
          output: {
            structured: { text: "read:read" },
            content: [{ type: "text", text: "read:read" }],
            },
          })
        expect(routerCalls.length).toBeGreaterThan(0)
        expect(routerCalls.at(-1)?.toolName).toBe("read")
        expect(routerCalls.at(-1)?.arguments).toEqual({ text: "read" })
        expect(routerCalls.at(-1)?.recentToolCalls).toEqual([])
      }),
    )

    consulted.effect("non-listed tools (bash) skip the gateway entirely", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        yield* service.register({ bash: make("bash") })
        const settled = yield* settleTool(service, call("bash"))
        expect(settled).toEqual({
          result: { type: "text", value: "bash:bash" },
          output: {
            structured: { text: "bash:bash" },
            content: [{ type: "text", text: "bash:bash" }],
          },
        })
        expect(routerCalls.length).toBe(0)
      }),
    )
  })

  describe("router test double (intelligence outcome is discarded — Phase 2 no observable change)", () => {
    intelligenceConsulted.effect("intelligence decision still settles unchanged and the router was consulted", () =>
      Effect.gen(function* () {
        intelRouterCalls.length = 0
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
        expect(intelRouterCalls.length).toBeGreaterThan(0)
        expect(intelRouterCalls.at(-1)?.toolName).toBe("grep")
      }),
    )
  })

  describe("AUGMENT outcome merged into the read page (Phase 7, spec §6.2/§29/§117)", () => {
    augmentConsulted.effect("read settle: header is prepended, type stays json, storage output untouched", () =>
      Effect.gen(function* () {
        gatewayCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* service.register({ read: pageRead, grep: make("grep"), glob: make("glob") })
        const settled = yield* settleTool(service, call("read"))
        // Model-facing result: header prefixed into the page content, type kept "json".
        expect(settled.result).toEqual({
          type: "json",
          value: {
            type: "text-page",
            content: "Symbol: Foo | Imports: 1 | References: 2 | Callers: 2 | Dependents: 1\nline one\nline two",
            mime: "text/plain",
            offset: 1,
            truncated: false,
          },
        })
        // Storage/TUI output is untouched: the merge is model-facing only.
        expect(settled.output?.structured).toEqual({
          type: "text-page",
          content: "line one\nline two",
          mime: "text/plain",
          offset: 1,
          truncated: false,
        })
        expect(gatewayCalls.at(-1)?.originalTool).toBe("read")
      }),
    )

    directConsulted.effect("direct outcome: read page unchanged (no prefix)", () =>
      Effect.gen(function* () {
        gatewayCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* service.register({ read: pageRead })
        const settled = yield* settleTool(service, call("read"))
        expect(settled.result).toEqual({
          type: "json",
          value: {
            type: "text-page",
            content: "line one\nline two",
            mime: "text/plain",
            offset: 1,
            truncated: false,
          },
        })
      }),
    )

    augmentConsulted.effect("augment outcome on grep: result unchanged (merge is read-only)", () =>
      Effect.gen(function* () {
        gatewayCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* service.register({ read: pageRead, grep: make("grep") })
        const settled = yield* settleTool(service, call("grep"))
        expect(settled.result).toEqual({ type: "text", value: "grep:grep" })
      }),
    )

    augmentConsulted.effect("augment outcome with a failed read: error settlement unchanged", () =>
      Effect.gen(function* () {
        gatewayCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* service.register({ read: failingRead })
        const settled = yield* settleTool(service, call("read"))
        expect(settled).toEqual({ result: { type: "error", value: "boom" } })
      }),
    )

    augmentConsulted.effect("augment outcome with non-page json settlement: unchanged (shape guard)", () =>
      Effect.gen(function* () {
        gatewayCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* service.register({ read: nonPageRead })
        const settled = yield* settleTool(service, call("read"))
        expect(settled.result).toEqual({ type: "json", value: { content: "raw content", mime: "text/plain" } })
      }),
    )
  })
})
