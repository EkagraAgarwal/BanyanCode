import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SubagentMessageTool } from "../../../core/src/tool/subagent-message"
import { SharedMemoryTool } from "../../../core/src/tool/shared-memory"
import { ToolRegistry } from "../../../core/src/tool/registry"
import { PermissionV2 } from "../../../core/src/permission"
import { Banyan } from "../../../core/src/banyancode"
import { SubagentBus } from "../../../core/src/banyancode/subagent-bus"
import { SubagentMessagesRepo } from "../../../core/src/banyancode/subagent-messages-repo"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "../lib/effect"
import path from "path"
import os from "os"

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
}))

const mockBusLayer = Layer.succeed(SubagentBus.Service, SubagentBus.Service.of({
  publish: (msg) => Effect.sync(() => mockMessages.push(msg)),
  subscribe: () => Effect.succeed({} as any),
  peers: () => Effect.succeed([]),
}))

const TEST_DB_PATH = path.join(os.tmpdir(), "opencode-subagent-mesh-test.sqlite")
const dbLayer = Database.layerFromPath(TEST_DB_PATH)
const memoryLayer = Banyan.memoryRepoDefaultLayer.pipe(Layer.provide(dbLayer))

const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(mockPermissionLayer))
const toolLayer = Layer.mergeAll(
  SubagentMessageTool.layer,
  SharedMemoryTool.layer,
).pipe(
  Layer.provide(registry),
  Layer.provide(mockPermissionLayer),
  Layer.provide(mockRepoLayer),
  Layer.provide(mockBusLayer),
  Layer.provide(memoryLayer),
  Layer.provide(dbLayer),
)

const it = testEffect(Layer.mergeAll(
  mockPermissionLayer,
  registry,
  mockRepoLayer,
  mockBusLayer,
  memoryLayer,
  dbLayer,
  toolLayer,
))

describe("subagent-mesh", () => {
  it.live("end-to-end mesh test with orchestrator and 3 background subagents", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      const bus = yield* SubagentBus.Service
      const repo = yield* SubagentMessagesRepo.Service

      const parentSessionID = "mesh-test-session"

      const mat = yield* tools.materialize()

      const messageToolDef = mat.definitions.find((d) => d.name === "subagent_message")
      if (!messageToolDef) throw new Error("subagent_message tool not registered")

      const memoryToolDef = mat.definitions.find((d) => d.name === "shared_memory")
      if (!memoryToolDef) throw new Error("shared_memory tool not registered")

      const ctx = {
        sessionID: parentSessionID as any,
        messageID: "msg-orch" as any,
        agent: "orchestrator" as any,
        assistantMessageID: "am-orch" as any,
        toolCallID: "tc-orch",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-write", name: "shared_memory", input: { op: "write", key: "shared:result", value: "" } },
      })

      const subagentSessions = ["subagent-1", "subagent-2", "subagent-3"]
      for (const saSession of subagentSessions) {
        const msg = {
          id: crypto.randomUUID(),
          parentSessionID,
          fromSession: saSession,
          fromAgent: saSession,
          kind: "inform" as const,
          payload: { status: "ready", session: saSession },
          createdAt: Date.now(),
        }
        yield* bus.publish(msg)
      }

      const allReady = yield* repo.listByParent(parentSessionID, false)
      expect(allReady.length).toBe(3)

      for (const saSession of subagentSessions) {
        const msg = {
          id: crypto.randomUUID(),
          parentSessionID,
          fromSession: saSession,
          fromAgent: saSession,
          kind: "request" as const,
          payload: { action: "compute", session: saSession },
          createdAt: Date.now(),
        }
        yield* bus.publish(msg)
      }

      const allRequests = yield* repo.listByParent(parentSessionID, false)
      expect(allRequests.length).toBe(6)

      yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-write2", name: "shared_memory", input: { op: "write", key: "shared:result", value: "computed" } },
      })
      const readShared = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-read", name: "shared_memory", input: { op: "read", key: "shared:result" } },
      })
      expect((readShared.output?.structured as any).ok).toBe(true)
      expect((readShared.output?.structured as any).entries[0].value).toBe("computed")

      const msgResult = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: { type: "tool-call", id: "call-msg", name: "subagent_message", input: { to: "subagent-1", kind: "request", payload: { action: "finalize" } } },
      })
      expect((msgResult.output?.structured as any).delivered).toBe(true)
      expect((msgResult.output?.structured as any).pending).toBe(7)

      const peers = yield* bus.peers(parentSessionID)
      expect(peers.length).toBe(0)
    }),
  )
})
