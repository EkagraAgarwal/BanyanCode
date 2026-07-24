import { describe, expect } from "bun:test"
import path from "path"
import os from "os"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { Database } from "@opencode-ai/core/database/database"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { SubagentMessageTool } from "@opencode-ai/core/tool/subagent-message"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `opencode-tool-registry-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
)
const dbLayer = Database.layerFromPath(TEST_DB_PATH)
const messagesRepoLayer = Banyan.subagentMessagesRepoDefaultLayer.pipe(Layer.provide(dbLayer))
const busLayer = Banyan.subagentBusDefaultLayer.pipe(Layer.provide(messagesRepoLayer))

const mockPermissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: () => Effect.succeed({ id: { _id: "per_test" } as never, effect: "allow" as const }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

const registryLayer = ToolRegistry.defaultLayer.pipe(Layer.provide(mockPermissionLayer))

const subagentToolLayer = SubagentMessageTool.layer.pipe(
  Layer.provide(registryLayer),
  Layer.provide(mockPermissionLayer),
  Layer.provide(busLayer),
  Layer.provide(messagesRepoLayer),
  Layer.provide(dbLayer),
)

const it = testEffect(
  Layer.mergeAll(
    mockPermissionLayer,
    registryLayer,
    subagentToolLayer,
    dbLayer,
    busLayer,
    messagesRepoLayer,
  ) as unknown as Layer.Layer<never, never, never>,
)

describe("tool.registry subagent_message wiring", () => {
  it.effect(
    "SubagentMessageTool registers 'subagent_message' when SubagentBus + SubagentMessagesRepo are provided",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const { definitions } = yield* registry.materialize()
        const names = definitions.map((d) => d.name)
        expect(names).toContain("subagent_message")
      }) as unknown as Effect.Effect<void, never, never>,
  )
})
