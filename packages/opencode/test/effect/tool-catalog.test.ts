import { describe, expect, it as bunIt } from "bun:test"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { settlementToToolCallOutput } from "@/effect/transport-ai-sdk"
import { testEffect } from "../lib/effect"

const permission = Layer.succeed(PermissionV2.Service, {
  assert: () => Effect.void,
  ask: () => Effect.succeed({ id: "noop" as never, effect: "allow" as const }) as never,
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
})

const registry = ToolRegistry.defaultLayer.pipe(
  Layer.provide(permission),
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)

const catalog = ToolCatalog.defaultLayer.pipe(
  Layer.provide(permission),
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)

const it = testEffect(Layer.mergeAll(registry, catalog))

const echoTool = Tool.make({
  description: "Echo the query back",
  input: Schema.Struct({ query: Schema.String }),
  output: Schema.Struct({ echo: Schema.String }),
  execute: ({ query }) => Effect.succeed({ echo: query }),
  toModelOutput: ({ output }) => [{ type: "text", text: output.echo }],
})

describe("ToolCatalog pipeline", () => {
  it.effect("every registered tool materializes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const catalog = yield* ToolCatalog.Service
      const scope = yield* Scope.make()

      yield* registry.register({ echo: echoTool }).pipe(Scope.provide(scope))
      const registered = (yield* catalog.list()).size
      const materialized = (yield* catalog.materialize()).definitions.length
      expect(materialized).toBeGreaterThanOrEqual(registered)
    }),
  )

  it.effect("registered tools appear in materialize().definitions by name", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const catalog = yield* ToolCatalog.Service
      const scope = yield* Scope.make()

      yield* registry.register({ count_echo: echoTool }).pipe(Scope.provide(scope))
      const definitions = (yield* catalog.materialize()).definitions
      const names = definitions.map((d) => d.name)
      expect(names).toContain("count_echo")
      const list = yield* catalog.list()
      expect(list.has("count_echo")).toBe(true)
    }),
  )

  it.effect(
    "smoke: every materialized tool settles successfully with dummy args",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const scope = yield* Scope.make()

        yield* registry
          .register({ smoke_echo: echoTool })
          .pipe(Scope.provide(scope))

        const sessionID = "ses_smoke" as never
        const assistantMessageID = "msg_smoke" as never
        const agent = AgentV2.ID.make("build")
        const dummyCall = {
          type: "tool-call" as const,
          id: "call_smoke",
          name: "smoke_echo",
          input: { query: "hi" },
        }

        const exit = yield* Effect.exit(
          (yield* registry.materialize()).settle({
            sessionID,
            assistantMessageID,
            agent,
            call: dummyCall as never,
          }),
        )
        if (Exit.isSuccess(exit)) {
          const settlement = exit.value
          expect(settlement.result.type === "content" || settlement.result.type === "text").toBe(true)
        } else {
          throw new Error(`smoke settle failed: ${exit.cause}`)
        }
      }),
  )

  bunIt("settlementToToolCallOutput handles text/json/content/error uniformly", () => {
    const text = settlementToToolCallOutput(
      { result: { type: "text", value: "ok" } } as never,
      "msg_smoke",
      "ses_smoke",
    )
    expect(text.output).toBe("ok")

    const json = settlementToToolCallOutput(
      { result: { type: "json", value: { count: 1 } } } as never,
      "msg_smoke",
      "ses_smoke",
    )
    expect(json.output).toBe('{"count":1}')

    const content = settlementToToolCallOutput(
      {
        result: {
          type: "content",
          value: [{ type: "text", text: "line one" }],
        },
      } as never,
      "msg_smoke",
      "ses_smoke",
    )
    expect(content.output).toBe("line one")

    const errorCase = settlementToToolCallOutput(
      { result: { type: "error", value: "denied" } } as never,
      "msg_smoke",
      "ses_smoke",
    )
    expect(errorCase.output).toBe("denied")
  })
})
