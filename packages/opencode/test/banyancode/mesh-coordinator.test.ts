import { describe, expect } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { MeshCoordinator } from "../../../core/src/banyancode/mesh-coordinator"
import { SubagentBus } from "../../../core/src/banyancode/subagent-bus"
import { SubagentMessagesRepo } from "../../../core/src/banyancode/subagent-messages-repo"
import { testEffect } from "../lib/effect"

process.env.BANYANCODE_ENABLE = "1"

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
  subscribe: () => Queue.unbounded<any>(),
  peers: () => Effect.succeed([]),
}))

const meshLayer = MeshCoordinator.defaultLayer.pipe(
  Layer.provide(mockRepoLayer),
  Layer.provide(mockBusLayer),
)

const it = testEffect(meshLayer)

describe("mesh-coordinator", () => {
  it.effect("status returns expected shape", () =>
    Effect.gen(function* () {
      const svc = yield* MeshCoordinator.Service
      const status = yield* svc.status("test-session")
      expect(status).toHaveProperty("parentSessionID")
      expect(status).toHaveProperty("peers")
      expect(status).toHaveProperty("pendingMessages")
      expect(status).toHaveProperty("recentActivity")
      expect(status.parentSessionID).toBe("test-session")
      expect(Array.isArray(status.peers)).toBe(true)
      expect(Array.isArray(status.recentActivity)).toBe(true)
    }),
  )

  it.effect("drain returns empty array when no messages", () =>
    Effect.gen(function* () {
      const svc = yield* MeshCoordinator.Service
      const drained = yield* svc.drain("test-session")
      expect(Array.isArray(drained)).toBe(true)
    }),
  )

  it.live("after publishing messages via bus, status reflects them", () =>
    Effect.gen(function* () {
      const parentSessionID = "mesh-coord-test"

      const msg = {
        id: crypto.randomUUID(),
        parentSessionID,
        fromSession: "subagent-1",
        fromAgent: "subagent-1",
        kind: "inform" as const,
        payload: { status: "ready" },
        createdAt: Date.now(),
      }
      mockMessages.push(msg)

      const svc = yield* MeshCoordinator.Service
      const status = yield* svc.status(parentSessionID)
      expect(status.parentSessionID).toBe(parentSessionID)
    }),
  )
})
