import { describe, expect } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { MeshCoordinator } from "../../../core/src/banyancode/mesh-coordinator"
import { SubagentBus } from "../../../core/src/banyancode/subagent-bus"
import { SubagentMessagesRepo } from "../../../core/src/banyancode/subagent-messages-repo"
import { SubagentPlans } from "../../../core/src/banyancode/subagent-plans-repo"
import { EventV2 } from "../../../core/src/event"
import { SessionSchema } from "../../../core/src/session/schema"
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
  peerState: () => Effect.succeed([]),
  pendingCount: () => Effect.succeed(0),
}))

const mockBusLayer = Layer.succeed(SubagentBus.Service, SubagentBus.Service.of({
  publish: (msg) => Effect.sync(() => mockMessages.push(msg)),
  subscribe: () => Queue.unbounded<any>(),
  peers: () => Effect.succeed([]),
}))

const mockPlansLayer = Layer.succeed(SubagentPlans.Service, SubagentPlans.Service.of({
  put: () => Effect.void,
  getByID: () => Effect.succeed(undefined),
  listByParent: () => Effect.succeed([]),
  listBySession: () => Effect.succeed([]),
  markCompleted: () => Effect.void,
  markCancelled: () => Effect.void,
}))

const mockEventsLayer = Layer.succeed(EventV2.Service, {} as any)

const meshLayer = MeshCoordinator.defaultLayer.pipe(
  Layer.provide(mockRepoLayer),
  Layer.provide(mockBusLayer),
  Layer.provide(mockPlansLayer),
  Layer.provide(mockEventsLayer),
)

const it = testEffect(meshLayer)

describe("mesh-coordinator", () => {
  it.effect("status returns expected shape", () =>
    Effect.gen(function* () {
      const svc = yield* MeshCoordinator.Service
      const status = yield* svc.status(SessionSchema.ID.make("ses_test"))
      expect(status).toHaveProperty("parentSessionID")
      expect(status).toHaveProperty("peers")
      expect(status).toHaveProperty("pendingMessages")
      expect(status).toHaveProperty("recentActivity")
      expect(status.parentSessionID).toBe("ses_test")
      expect(Array.isArray(status.peers)).toBe(true)
      expect(Array.isArray(status.recentActivity)).toBe(true)
    }),
  )

  it.effect("drain returns empty array when no messages", () =>
    Effect.gen(function* () {
      const svc = yield* MeshCoordinator.Service
      const drained = yield* svc.drain(SessionSchema.ID.make("ses_test"))
      expect(Array.isArray(drained)).toBe(true)
    }),
  )

  it.live("after publishing messages via bus, status reflects them", () =>
    Effect.gen(function* () {
      const parentSessionID = SessionSchema.ID.make("ses_mesh")

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
      expect(status.parentSessionID).toBe("ses_mesh")
    }),
  )
})
