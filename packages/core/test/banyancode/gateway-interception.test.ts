import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import { ToolRouterService } from "../../src/banyancode/gateway/router"
import type { RouterInput } from "../../src/banyancode/gateway/types"
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
})
