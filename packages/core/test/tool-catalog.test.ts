import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolCatalog } from "@opencode-ai/core/tool/tool-catalog"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tools } from "@opencode-ai/core/tool/tools"
import { testEffect } from "./lib/effect"

const permission = Layer.succeed(PermissionV2.Service, {
  assert: () => Effect.void,
  ask: () => Effect.succeed({ id: "noop" as never, effect: "allow" as const }) as never,
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
})

const it = testEffect(
  Layer.mergeAll(
    ToolRegistry.defaultLayer.pipe(
      Layer.provide(permission),
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
    ),
    ToolCatalog.defaultLayer.pipe(
      Layer.provide(permission),
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
    ),
  ),
)

const sessionID = SessionV2.ID.make("ses_catalog")
const assistantMessageID = SessionMessage.ID.make("msg_catalog")
const agent = AgentV2.ID.make("build")

const echoTool = Tool.make({
  description: "Echo the query back as JSON",
  input: Schema.Struct({ query: Schema.String }),
  output: Schema.Struct({ echo: Schema.String }),
  execute: ({ query }) => Effect.succeed({ echo: query }),
  toModelOutput: ({ output }) => [{ type: "text", text: output.echo }],
})

describe("ToolCatalog", () => {
  it.effect("list() returns the catalog after Tools.Service.register", () =>
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const catalog = yield* ToolCatalog.Service
      const scope = yield* Scope.make()

      expect((yield* catalog.list()).size).toBe(0)

      yield* tools.register({ echo: echoTool }).pipe(Scope.provide(scope))
      expect([...(yield* catalog.list()).keys()]).toEqual(["echo"])

      const materialized = yield* catalog.materialize()
      expect(materialized.definitions.map((d) => d.name)).toEqual(["echo"])

      yield* Scope.close(scope, Exit.void)
      expect([...(yield* catalog.list()).keys()]).toEqual([])
    }),
  )

  it.effect("materialize count matches list count for any registration set", () =>
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const catalog = yield* ToolCatalog.Service
      const scope = yield* Scope.make()

      yield* tools.register({ echo: echoTool, second: echoTool }).pipe(Scope.provide(scope))
      const registered = (yield* catalog.list()).size
      const materialized = (yield* catalog.materialize()).definitions.length
      expect(materialized).toBe(registered)

      const input = {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call" as const, id: "call-1", name: "echo", input: { query: "hi" } },
      }
      const settlement = yield* catalog.materialize().pipe(Effect.flatMap((m) => m.settle(input)))
      expect(settlement.result.type).toBe("text")
      if (settlement.result.type === "text") expect(settlement.result.value).toBe("hi")
    }),
  )
})
