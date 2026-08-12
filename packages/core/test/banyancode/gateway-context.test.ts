import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { RepositoryGateway } from "../../src/banyancode/gateway"
import {
  defaultLayer as investigationStateDefaultLayer,
  Service as InvestigationStateService,
} from "../../src/banyancode/gateway/investigation"
import { ToolRouterService } from "../../src/banyancode/gateway/router"
import type { RouterInput } from "../../src/banyancode/gateway/types"
import { testEffect } from "../lib/effect"
import { settleTool } from "../lib/tool"

process.env.BANYANCODE_ENABLE = "1"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const registry = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))

// Recording router double: captures every RouterInput the gateway classifies so
// tests can assert the Phase 6 context (userRequest / recentToolCalls /
// investigationState) that the registry hook attaches before executing.
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
const gateway = RepositoryGateway.layer.pipe(Layer.provide(recordingRouter))

// Session-store fixture: one user message plus prior assistant tool calls.
// The hook reads this via SessionStore.Service.context(sessionID) and derives
// userRequest (last user text) + recentToolCalls (last 5 assistant tool names).
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const sessionMessages: SessionMessage.Message[] = [
  new SessionMessage.User({
    id: SessionMessage.ID.make("msg_context_user"),
    type: "user",
    text: "Find all references to AuthManager",
    time: { created },
  }),
  new SessionMessage.Assistant({
    id: SessionMessage.ID.make("msg_context_assistant"),
    type: "assistant",
    agent: "build",
    model,
    content: [
      new SessionMessage.AssistantText({ type: "text", id: "text-1", text: "Checking" }),
      new SessionMessage.AssistantTool({
        type: "tool",
        id: "tool-grep",
        name: "grep",
        state: new SessionMessage.ToolStateCompleted({
          status: "completed",
          input: { pattern: "AuthManager" },
          content: [],
          structured: {},
        }),
        time: { created },
      }),
      new SessionMessage.AssistantTool({
        type: "tool",
        id: "tool-read",
        name: "read",
        state: new SessionMessage.ToolStateCompleted({
          status: "completed",
          input: { path: "src/auth.ts" },
          content: [],
          structured: {},
        }),
        time: { created },
      }),
    ],
    time: { created },
  }),
]

const sessionStore = Layer.mock(SessionStore.Service, {
  context: () => Effect.succeed(sessionMessages),
})

const identity = {
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_context"),
}
const sessionID = SessionV2.ID.make("ses_context")
const call = (name: string, input: Record<string, unknown> = { text: name }): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}`, name, input },
})

const make = (name: string) =>
  Tool.make({
    description: `${name} probe`,
    input: Schema.Struct({ text: Schema.String, pattern: Schema.String.pipe(Schema.optional) }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text: `${name}:${text}` }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })

const registerProbes = (service: ToolRegistry.Interface) =>
  service.register({ read: make("read"), grep: make("grep"), glob: make("glob") })

// Runtime 1 — full context: gateway + recording router + mocked session store +
// investigation state. The hook must attach userRequest/recentToolCalls/
// investigationState to the routed request.
const withContext = testEffect(
  Layer.provideMerge(
    registry,
    Layer.mergeAll(gateway, sessionStore, investigationStateDefaultLayer),
  ),
)

// Runtime 2 — no session store in scope: the hook's serviceOption resolves
// None, so userRequest/recentToolCalls are undefined/[] and the settle path is
// byte-identical to the pre-Phase-6 behavior.
const noStore = testEffect(
  Layer.provideMerge(registry, Layer.mergeAll(gateway, investigationStateDefaultLayer)),
)

describe("RepositoryGateway Gate B context (plan §2.2)", () => {
  describe("session context via SessionStore.Service", () => {
    withContext.effect("settleWith passes userRequest = last user message text (truncated)", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        yield* settleTool(service, call("read"))
        expect(routerCalls.at(-1)?.userRequest).toBe("Find all references to AuthManager")
        expect(routerCalls.at(-1)?.userRequest?.length).toBeLessThanOrEqual(200)
      }),
    )

    withContext.effect("recentToolCalls contains the prior assistant tool names", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        yield* settleTool(service, call("read"))
        expect(routerCalls.at(-1)?.recentToolCalls.map((call) => call.tool)).toEqual(["grep", "read"])
      }),
    )
  })

  describe("investigation state", () => {
    withContext.effect("a grep settle records an identifier pattern as an entity", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        yield* settleTool(service, call("grep", { pattern: "AuthManager" }))
        const investigation = yield* InvestigationStateService
        const state = yield* investigation.get(sessionID, identity.agent)
        expect(state.entities.has("AuthManager")).toBe(true)
        expect(state.files.size).toBe(0)
        expect(state.concepts.size).toBe(0)
      }),
    )

    withContext.effect("a read settle records the file path", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        yield* settleTool(service, call("read", { path: "src/auth.ts" }))
        const investigation = yield* InvestigationStateService
        const state = yield* investigation.get(sessionID, identity.agent)
        expect(state.files.has("src/auth.ts")).toBe(true)
      }),
    )

    withContext.effect("a non-identifier grep pattern is recorded as a concept", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        yield* settleTool(service, call("grep", { pattern: "who calls Foo" }))
        const investigation = yield* InvestigationStateService
        const state = yield* investigation.get(sessionID, identity.agent)
        expect(state.concepts.has("who calls Foo")).toBe(true)
      }),
    )

    withContext.effect("state is scoped per (session, agent)", () =>
      Effect.gen(function* () {
        routerCalls.length = 0
        const service = yield* ToolRegistry.Service
        yield* registerProbes(service)
        yield* settleTool(service, call("grep", { pattern: "AuthManager" }))
        const investigation = yield* InvestigationStateService
        const otherSession = yield* investigation.get(
          SessionV2.ID.make("ses_other"),
          identity.agent,
        )
        expect(otherSession.entities.size).toBe(0)
      }),
    )
  })

  describe("fail-closed without a session store", () => {
    noStore.effect("userRequest/recentToolCalls stay undefined/[] and settle is unchanged", () =>
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
        expect(routerCalls.at(-1)?.userRequest).toBeUndefined()
        expect(routerCalls.at(-1)?.recentToolCalls).toEqual([])
      }),
    )
  })
})
