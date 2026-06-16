import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SubagentMessageTool } from "../../../core/src/tool/subagent-message"
import { SharedMemoryTool } from "../../../core/src/tool/shared-memory"
import { ToolRegistry } from "../../../core/src/tool/registry"
import { PermissionV2 } from "../../../core/src/permission"
import { SubagentBus } from "../../../core/src/banyancode/subagent-bus"
import { SubagentMessagesRepo } from "../../../core/src/banyancode/subagent-messages-repo"
import { Database } from "@opencode-ai/core/database/database"
import { Banyan } from "@opencode-ai/core/banyancode"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

const mockPermissionLayer = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
  ask: () => Effect.succeed({ id: { _id: "per_test" } as any, effect: "allow" as const }),
  assert: () => Effect.void,
  reply: () => Effect.void,
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
}))

const mockMessages: any[] = []
const mockRepoLayer = Layer.succeed(SubagentMessagesRepo.Service, SubagentMessagesRepo.Service.of({
  put: (msg) => Effect.sync(() => mockMessages.push(msg)),
  get: () => Effect.succeed(undefined),
  listByParent: (parentSessionID: string, delivered: boolean) =>
    Effect.succeed(mockMessages.filter(m => m.parentSessionID === parentSessionID && (delivered ? m.deliveredAt : !m.deliveredAt))),
  markDelivered: () => Effect.void,
  listPending: (parentSessionID: string) =>
    Effect.succeed(mockMessages.filter(m => m.parentSessionID === parentSessionID && !m.deliveredAt)),
  peerState: () => Effect.succeed([]),
  pendingCount: () => Effect.succeed(0),
}))

const mockBusLayer = Layer.succeed(SubagentBus.Service, SubagentBus.Service.of({
  publish: (msg) => Effect.sync(() => mockMessages.push(msg)),
  subscribe: () => Effect.succeed({} as any),
  peers: () => Effect.succeed([]),
}))

const dbLayer = Database.layerFromPath(":memory:")
const memoryRepoLayer = Banyan.memoryRepoLayer.pipe(Layer.provide(dbLayer))
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(mockPermissionLayer), Layer.provide(memoryRepoLayer))
const toolLayer = Layer.mergeAll(
  SubagentMessageTool.layer,
  SharedMemoryTool.locationLayer,
).pipe(
  Layer.provide(registry),
  Layer.provide(mockPermissionLayer),
  Layer.provide(mockRepoLayer),
  Layer.provide(mockBusLayer),
  Layer.provide(memoryRepoLayer),
  Layer.provide(dbLayer),
)

const it = testEffect(Layer.mergeAll(
  mockPermissionLayer,
  registry,
  mockRepoLayer,
  mockBusLayer,
  dbLayer,
  memoryRepoLayer,
  toolLayer,
) as any)

describe("subagent-mesh", () => {
  it.live("end-to-end mesh test with orchestrator and 3 background subagents", () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()

      const ctx = {
        sessionID: "mesh-test-session" as any,
        messageID: "msg-1" as any,
        agent: "orchestrator" as any,
        assistantMessageID: "am-1" as any,
        toolCallID: "tc-1",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      // Write a checkpoint
      const writeResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-checkpoint", name: "shared_memory", input: { op: "write", key: "checkpoint", value: { step: 1, status: "running" } } },
      })
      expect((writeResult.output?.structured as any).ok).toBe(true)

      // Read it back
      const readResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-read", name: "shared_memory", input: { op: "read", key: "checkpoint" } },
      })
      expect((readResult.output?.structured as any).ok).toBe(true)
      expect((readResult.output?.structured as any).entries[0].value).toEqual({ step: 1, status: "running" })
    }),
  )
})