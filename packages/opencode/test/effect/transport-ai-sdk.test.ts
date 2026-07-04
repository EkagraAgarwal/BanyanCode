import { describe, expect, it as bunIt } from "bun:test"
import { Effect, Layer, Schema, Scope } from "effect"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Service as AiSdkTransport, buildTools, layer as aiSdkLayer, settlementToToolCallOutput } from "@/effect/transport-ai-sdk"
import { Option } from "effect"
import type { ToolMaterializationContext } from "@/effect/tool-transport"

const permission = Layer.succeed(PermissionV2.Service, {
  assert: () => Effect.void,
  ask: () => Effect.succeed({ id: "noop" as never, effect: "allow" as const }) as never,
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
})

const backing = Layer.mergeAll(
  ToolOutputStore.defaultLayer,
  Layer.succeed(PermissionV2.Service, {
    assert: () => Effect.void,
    ask: () => Effect.succeed({ id: "noop" as never, effect: "allow" as const }) as never,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

const echoTool = Tool.make({
  description: "Echo the query back",
  input: Schema.Struct({ query: Schema.String }),
  output: Schema.Struct({ echo: Schema.String }),
  execute: ({ query }) => Effect.succeed({ echo: query }),
  toModelOutput: ({ output }) => [{ type: "text", text: output.echo }],
})

const testLayers = Layer.mergeAll(
  ToolRegistry.defaultLayer.pipe(
    Layer.provide(permission),
    Layer.provide(ApplicationTools.layer),
    Layer.provide(ToolOutputStore.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.defaultLayer),
  ),
  ToolCatalog.defaultLayer.pipe(
    Layer.provide(permission),
    Layer.provide(ApplicationTools.layer),
    Layer.provide(ToolOutputStore.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.defaultLayer),
  ),
  aiSdkLayer as unknown as Layer.Layer<unknown, unknown, never>,
)
const it = testEffect(testLayers)

const baseContext = (): ToolMaterializationContext =>
  ({
    sessionID: "ses_test",
    assistantMessageID: "msg_test",
    agent: "build",
    model: {
      api: { id: "test-model", url: "" },
      id: "test-model",
      providerID: "test",
      limit: { context: 1, output: 1 },
    },
    messages: [],
    workspace: undefined,
    permissions: [],
    run: {
      promise: () => Promise.resolve({} as never),
      fork: () => ({}) as never,
      run: () => Effect.void,
      bind: () => () => {},
    } as never,
    pluginTrigger: () => Effect.void,
    completeToolCall: () => Effect.void,
  }) as never

describe("AiSdkTransport layer", () => {
  it.effect("AiSdkTransport is in scope with the canonical id", () =>
    Effect.gen(function* () {
      const option = yield* Effect.serviceOption(AiSdkTransport)
      expect(Option.isSome(option)).toBe(true)
      if (Option.isSome(option)) {
        const transport = option.value as { id: symbol }
        expect(typeof transport.id).toBe("symbol")
        expect(String(transport.id)).toContain("@opencode/AiSdkToolTransport")
      }
    }),
  )

  it.effect("buildTools returns one entry per canonical definition", () =>
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const catalog = yield* ToolCatalog.Service
      const scope = yield* Scope.make()
      yield* tools.register({ echo: echoTool, count_echo: echoTool }).pipe(Scope.provide(scope))

      const materializations = yield* buildTools({
        catalog: catalog as never,
        ctx: baseContext(),
      })

      const ids = materializations.map((m) => m.id).toSorted()
      expect(ids).toEqual(["count_echo", "echo"])
      for (const { id, tool: aiTool } of materializations) {
        expect(typeof id).toBe("string")
        expect(typeof aiTool).toBe("object")
        expect(typeof (aiTool as { execute?: unknown }).execute).toBe("function")
      }
    }),
  )

  it.effect("buildTools preserves ToolDefinition names exactly", () =>
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const catalog = yield* ToolCatalog.Service
      const scope = yield* Scope.make()
      yield* tools.register({ first: echoTool, second: echoTool, third: echoTool }).pipe(
        Scope.provide(scope),
      )

      const definitions = (yield* catalog.materialize()).definitions
      expect(definitions.map((d) => d.name).toSorted()).toEqual(["first", "second", "third"])

      const materializations = yield* buildTools({
        catalog: catalog as never,
        ctx: baseContext(),
      })

      expect(materializations.length).toBe(definitions.length)
      expect(materializations.map((m) => m.id).toSorted()).toEqual(["first", "second", "third"])
    }),
  )
})

describe("settlementToToolCallOutput", () => {
  bunIt("renders a text settlement as plain output", () => {
    const out = settlementToToolCallOutput(
      { result: { type: "text", value: "hello world" } } as never,
      "msg_test",
      "ses_test",
    )
    expect(out.output).toBe("hello world")
    expect(out.title).toBe("")
    expect(out.attachments.length).toBe(0)
  })

  bunIt("renders a json settlement by stringifying the value", () => {
    const out = settlementToToolCallOutput(
      { result: { type: "json", value: { ok: true, count: 3 } } } as never,
      "msg_test",
      "ses_test",
    )
    expect(out.output).toBe('{"ok":true,"count":3}')
  })

  bunIt("renders a content settlement by joining text parts", () => {
    const out = settlementToToolCallOutput(
      {
        result: {
          type: "content",
          value: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      } as never,
      "msg_test",
      "ses_test",
    )
    expect(out.output).toBe("first\n\nsecond")
  })

  bunIt("renders an error settlement as plain output", () => {
    const out = settlementToToolCallOutput(
      { result: { type: "error", value: "permission denied" } } as never,
      "msg_test",
      "ses_test",
    )
    expect(out.output).toBe("permission denied")
  })
})
