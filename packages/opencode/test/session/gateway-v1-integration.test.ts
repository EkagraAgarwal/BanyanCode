import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Banyan } from "@opencode-ai/core/banyancode"
import { SessionTools } from "../../src/session/tools"
import { GatewayV1 } from "../../src/session/gateway-v1"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry as OpencodeToolRegistry } from "../../src/tool/registry"
import { Plugin } from "../../src/plugin"
import { Permission } from "../../src/permission"
import { MCP } from "../../src/mcp"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { SessionProcessor } from "../../src/session/processor"
import type { TaskPromptOps } from "../../src/tool/task"
import { testEffect } from "../lib/effect"

// The V1 gateway seam lives inside SessionTools.resolve's execute wrapper
// (packages/opencode/src/session/tools.ts:99-138): an optional
// Banyan.RepositoryGateway service is consulted for the allowlisted
// repository tools (read/grep/glob) and its outcome is applied to the result
// (GatewayV1.applyOutcome). This file proves the seam end-to-end through the
// real resolve() with a lightweight harness: every service resolve touches is
// mocked, and the gateway itself is a recording double fed directly into the
// hook, bypassing router + backends.
//
// resolve() refuses to run when BanyanCode is enabled but the AiSdkTransport
// / ToolCatalog services are absent (tools.ts:164-178). The gateway hook does
// NOT read this env var, so BANYANCODE_ENABLE=0 keeps the harness minimal
// without disabling the seam under test.

process.env.BANYANCODE_ENABLE = "0"

// --- Probe tools (GATEWAY_TOOLS ids only) ------------------------------------

const makeProbe = (id: string): Tool.Def => ({
  id,
  description: `${id} probe`,
  parameters: Schema.Unknown,
  execute: (_args, _ctx) => Effect.succeed({ title: "probe", output: "PAGE_BODY", metadata: {} }),
})

const readProbe = makeProbe("read")
const grepProbe = makeProbe("grep")

// Mutable probe list so one harness serves all four cases (Layer.mock's
// closures read the current value at call time).
let probeTools: Tool.Def[] = [readProbe]

// --- Service doubles for everything SessionTools.resolve touches -------------

const registryDouble = Layer.mock(OpencodeToolRegistry.Service, {
  tools: () => Effect.succeed(probeTools),
  ids: () => Effect.succeed(probeTools.map((tool) => tool.id)),
  all: () => Effect.succeed(probeTools),
})

const pluginDouble = Layer.mock(Plugin.Service, {
  trigger: <Name extends string, Input = never, Output = never>(
    _name: Name,
    _input: Input,
    _output: Output,
  ) => Effect.succeed(undefined as Output),
  list: () => Effect.succeed([]),
})

const permissionDouble = Layer.mock(Permission.Service, {
  ask: () => Effect.succeed(undefined),
})

const mcpDouble = Layer.mock(MCP.Service, {
  tools: () => Effect.succeed({}),
})

const truncateDouble = Layer.mock(Truncate.Service, {
  output: () => Effect.succeed({ content: "PAGE_BODY", truncated: false }),
})

const baseLayer = Layer.mergeAll(registryDouble, pluginDouble, permissionDouble, mcpDouble, truncateDouble)

// --- Gateway double: feeds the hook exactly what applyOutcome consumes -------

let fixedOutcome: Banyan.RepositoryGatewayNS.GatewayOutcome = { route: "direct" }
const gatewayRequests: Banyan.RepositoryGatewayTypes.RepositoryRequest[] = []
const gatewayDouble = Layer.mock(Banyan.RepositoryGateway, {
  execute: (request) =>
    Effect.sync(() => {
      gatewayRequests.push(request)
      return fixedOutcome
    }),
})

// --- Runtimes: gateway mounted only where the seam is under test -------------

const noGateway = testEffect(baseLayer)
const withGateway = testEffect(Layer.provideMerge(baseLayer, gatewayDouble))
const investigated = testEffect(
  Layer.provideMerge(Layer.provideMerge(baseLayer, gatewayDouble), Banyan.InvestigationState.layer),
)
// Kill-switch runtime: BanyanConfigService with an explicit per-tool off flag.
// routeAllowed reads it via serviceOption (fail-closed -> allowed when absent).
const grepDisabledConfig = Layer.mock(Banyan.BanyanConfigService, {
  get: () => Effect.succeed({ banyancode_route_grep: false }),
  getGlobal: () => Effect.succeed({}),
})
const withGrepDisabled = testEffect(Layer.provideMerge(Layer.provideMerge(baseLayer, gatewayDouble), grepDisabledConfig))

// --- resolve() input stubs ----------------------------------------------------

const agentStub = { name: "build", mode: "primary", permission: [], options: {} } as unknown as Agent.Info
const modelStub = { providerID: "test", api: { id: "test-model" } } as unknown as Provider.Model
const sessionStub = { id: "s_gateway" } as unknown as Session.Info
const processorStub: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall"> = {
  message: { id: "msg_1" } as unknown as SessionV1.Assistant,
  updateToolCall: () => Effect.succeed(undefined),
  completeToolCall: () => Effect.void,
}

// --- Messages (Gate B context: last user text + recent tool parts) -----------

const userMessage = (text: string): SessionV1.WithParts =>
  ({
    info: {
      role: "user",
      id: "u1",
      sessionID: "s1",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
    },
    parts: [{ type: "text", id: "u1p", sessionID: "s1", text }],
  }) as unknown as SessionV1.WithParts

const toolPart = (tool: string, input: Record<string, unknown>) => ({
  type: "tool" as const,
  id: `t-${tool}`,
  sessionID: "s1",
  callID: `c-${tool}`,
  tool,
  state: { status: "completed" as const, input, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
})

const assistantMessage = (parts: unknown[]): SessionV1.WithParts =>
  ({
    info: {
      role: "assistant",
      id: "a1",
      sessionID: "s1",
      time: { created: 0 },
      parentID: "u1",
      modelID: "test-model",
      providerID: "test",
      mode: "default",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { input: 0, output: 0, reasoning: 0 } },
    },
    parts,
  }) as unknown as SessionV1.WithParts

const messages: SessionV1.WithParts[] = [userMessage("who calls Foo?"), assistantMessage([toolPart("read", { path: "src/foo.ts" })])]

// --- Fixed gateway outcomes (GatewayOutcome union from core) ------------------

const augmentOutcome: Banyan.RepositoryGatewayNS.GatewayOutcome = {
  route: "augment",
  header: "## Symbol Foo (1 ref)",
  result: {
    route: "augment",
    operation: { kind: "content", path: "src/foo.ts" },
    source: "codegraph",
    results: [],
    header: "## Symbol Foo (1 ref)",
    provenance: { originalTool: "read", resolvedOperation: "content", router: "rules", routerVersion: "1" },
  },
}

const intelligenceOutcome: Banyan.RepositoryGatewayNS.GatewayOutcome = {
  route: "intelligence",
  result: {
    route: "intelligence",
    operation: { kind: "relationship", relation: "callers", target: "Foo" },
    source: "codegraph",
    results: [{ path: "src/a.ts", line: 42, name: "Foo", text: "calls" }],
    provenance: { originalTool: "grep", resolvedOperation: "callers(Foo)", router: "rules", routerVersion: "1" },
    freshness: { graph: "fresh" },
  },
}

// --- Driver: resolve + execute one tool through the real wrapper --------------

const executeTool = (toolID: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const resolved = yield* SessionTools.resolve({
      agent: agentStub,
      model: modelStub,
      session: sessionStub,
      processor: processorStub,
      bypassAgentCheck: true,
      messages,
      promptOps: {} as TaskPromptOps,
    })
    const aiTool = resolved[toolID]
    expect(aiTool).toBeDefined()
    const execute = aiTool.execute as (
      args: Record<string, unknown>,
      options: { toolCallId: string; abortSignal: AbortSignal },
    ) => Promise<{ title: string; output: string; metadata: Record<string, unknown>; attachments?: unknown[] }>
    return yield* Effect.promise(() => execute(args, { toolCallId: "call_1", abortSignal: new AbortController().signal }))
  })

describe("SessionTools.resolve gateway seam", () => {
  describe("gateway absent (serviceOption None)", () => {
    noGateway.effect("execute output is byte-identical", () =>
      Effect.gen(function* () {
        probeTools = [readProbe]
        const output = yield* executeTool("read", { path: "src/foo.ts" })
        expect(output.output).toBe("PAGE_BODY")
      }),
    )
  })

  describe("gateway present", () => {
    investigated.effect("augment prepends the header on read and notes investigation state", () =>
      Effect.gen(function* () {
        probeTools = [readProbe]
        fixedOutcome = augmentOutcome
        gatewayRequests.length = 0
        const output = yield* executeTool("read", { path: "src/foo.ts" })
        // AUGMENT: header prepended, original content preserved.
        expect(output.output).toBe("## Symbol Foo (1 ref)\nPAGE_BODY")
        // Codegraph indicator: the stored metadata flags the interception so
        // the TUI can render the gear glyph next to the tool call.
        expect(output.metadata).toMatchObject({ codegraph: true })
        // Gate A: the hook consulted the gateway with the routed tool + Gate B context.
        expect(gatewayRequests.at(-1)?.originalTool).toBe("read")
        expect(gatewayRequests.at(-1)?.userRequest).toBe("who calls Foo?")
        expect(gatewayRequests.at(-1)?.recentToolCalls).toEqual([{ tool: "read", arguments: { path: "src/foo.ts" } }])
        // Investigation state: read noted the file into the (session, agent) bucket.
        const investigation = yield* Banyan.InvestigationStateService
        const state = yield* investigation.get(sessionStub.id, AgentV2.ID.make("build"))
        expect([...state.files]).toEqual(["src/foo.ts"])
      }),
    )

    withGateway.effect("intelligence substitutes the output on grep", () =>
      Effect.gen(function* () {
        probeTools = [grepProbe]
        fixedOutcome = intelligenceOutcome
        gatewayRequests.length = 0
        const output = yield* executeTool("grep", { pattern: "Foo" })
        // INTELLIGENCE: rendered callers list replaces the leaf output.
        expect(output.output).not.toContain("PAGE_BODY")
        expect(output.output).toContain("Foo callers:")
        expect(output.output).toContain("src/a.ts:42 (Foo)")
        // Codegraph indicator flag rides along in the stored metadata.
        expect(output.metadata).toMatchObject({ codegraph: true })
      }),
    )

    withGateway.effect("direct outcome is byte-identical", () =>
      Effect.gen(function* () {
        probeTools = [readProbe]
        fixedOutcome = { route: "direct" }
        gatewayRequests.length = 0
        const output = yield* executeTool("read", { path: "src/foo.ts" })
        expect(output.output).toBe("PAGE_BODY")
        // Direct: no codegraph flag in metadata.
        expect(output.metadata).not.toMatchObject({ codegraph: true })
        // Seam still consulted the gateway before falling through.
        expect(gatewayRequests.at(-1)?.originalTool).toBe("read")
      }),
    )

    withGrepDisabled.effect("banyancode_route_grep: false bypasses the gateway for grep", () =>
      Effect.gen(function* () {
        probeTools = [grepProbe]
        fixedOutcome = intelligenceOutcome
        gatewayRequests.length = 0
        const output = yield* executeTool("grep", { pattern: "Foo" })
        // Kill-switch: gateway never consulted, leaf output byte-identical.
        expect(output.output).toBe("PAGE_BODY")
        expect(gatewayRequests.length).toBe(0)
      }),
    )

    withGrepDisabled.effect("read still routes with only grep disabled", () =>
      Effect.gen(function* () {
        probeTools = [readProbe]
        fixedOutcome = augmentOutcome
        gatewayRequests.length = 0
        const output = yield* executeTool("read", { path: "src/foo.ts" })
        // The read kill-switch is unset, so the augment header still fires.
        expect(output.output).toBe("## Symbol Foo (1 ref)\nPAGE_BODY")
        expect(gatewayRequests.at(-1)?.originalTool).toBe("read")
      }),
    )
  })

  describe("GatewayV1 sanity", () => {
    // Cheap guard that the allowlist matches what this test drives.
    test("read and grep are gateway tools", () => {
      expect(GatewayV1.GATEWAY_TOOLS.has("read")).toBe(true)
      expect(GatewayV1.GATEWAY_TOOLS.has("grep")).toBe(true)
    })
  })
})
