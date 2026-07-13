import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { SubagentConsumer, layer } from "@opencode-ai/core/banyancode/subagent-consumer"
import { SubagentBus } from "@opencode-ai/core/banyancode/subagent-bus"
import { MemoryRepo } from "@opencode-ai/core/banyancode/memory-repo"
import { SubagentMessagesRepo } from "@opencode-ai/core/banyancode/subagent-messages-repo"
import { MeshCoordinator } from "@opencode-ai/core/banyancode/mesh-coordinator"
import { SubagentPlans } from "@opencode-ai/core/banyancode/subagent-plans-repo"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { Banyan } from "@opencode-ai/core/banyancode"
import type { SubagentMessage } from "@opencode-ai/core/banyancode/types"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const buildLayer = (dbPath: string, queue: Queue.Queue<SubagentMessage>) => {
  const dbLayer = Database.layerFromPath(dbPath)

  const mockBus = Layer.succeed(
    SubagentBus.Service,
    SubagentBus.Service.of({
      publish: () => Effect.void,
      publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
      subscribe: () => Effect.succeed(queue),
      peers: () => Effect.succeed([]),
    }),
  )

  const mockMesh = Layer.succeed(
    MeshCoordinator.Service,
    MeshCoordinator.Service.of({
      status: () => Effect.die("not used"),
      trackParent: () => Effect.void,
      listTrackedParents: () => Effect.succeed([]),
      drain: () => Effect.succeed([]),
      watch: () => Effect.die("not used"),
      subscribe: () => Effect.die("not used"),
      checkin: () => Effect.succeed([]),
      steer: () => Effect.void,
      kill: () => Effect.void,
      planFor: () => Effect.void,
      tryReserveSubagentSlot: () => Effect.succeed({ ok: true, killed: null }),
      registerConsumer: () => Effect.void,
      unregisterConsumer: () => Effect.void,
      runGarbageCollection: () => Effect.succeed({ swept: 0, interrupted: 0 }),
    }),
  )

  const mockPlans = Layer.succeed(
    SubagentPlans.Service,
    SubagentPlans.Service.of({
      put: () => Effect.void,
      getByID: () => Effect.succeed(undefined),
      listByParent: () => Effect.succeed([]),
      listBySession: () => Effect.succeed([]),
      markCompleted: () => Effect.void,
      markCancelled: () => Effect.void,
    }),
  )

  // Real MemoryRepo + SubagentMessagesRepo against the test DB; mock SubagentBus and MeshCoordinator.
  // Provide them in the order the consumer's internal layer expects.
  const memoryLayer = Banyan.memoryRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))
  const consumerLayer = layer.pipe(
    Layer.provide(mockBus),
    Layer.provide(memoryLayer),
    Layer.provide(messagesLayer),
    Layer.provide(mockPlans),
    Layer.provide(mockMesh),
  )
  return Layer.mergeAll(consumerLayer, memoryLayer, messagesLayer)
}

describe("SubagentConsumer plan idempotency", () => {
  test("redelivering the same plan message does not duplicate the memory row", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "subagent-idem.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const serviceLayer = buildLayer(dbPath, queue)
    const dbLayer = Database.layerFromPath(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const consumer = yield* SubagentConsumer.Service
        const memory = yield* MemoryRepo.Service
        const messages = yield* SubagentMessagesRepo.Service

        yield* messages.put({
          id: "msg-redelivery",
          parentSessionID: "ses_ide" as any,
          fromSession: "ses_ide" as any,
          fromAgent: "coder",
          kind: "plan",
          payload: { steps: ["a", "b"] },
          createdAt: 1700000000000,
        })

        yield* consumer.start(
          { sessionID: "ses_ide" as any, agent: "coder" },
          yield* Effect.scope,
        )

        // Deliver the same message id twice — the consumer should write
        // one entry, then bump the version on redelivery.
        yield* Queue.offer(queue, {
          id: "msg-redelivery",
          parentSessionID: "ses_ide" as any,
          fromSession: "ses_ide" as any,
          fromAgent: "coder",
          kind: "plan",
          payload: { steps: ["a", "b"] },
          createdAt: 1700000000000,
        })
        yield* Effect.sleep(40)
        yield* Queue.offer(queue, {
          id: "msg-redelivery",
          parentSessionID: "ses_ide" as any,
          fromSession: "ses_ide" as any,
          fromAgent: "coder",
          kind: "plan",
          payload: { steps: ["a", "b"] },
          createdAt: 1700000000000,
        })
        yield* Effect.sleep(40)

        const sessionEntries = yield* memory.list("session", "ses_ide")
        expect(sessionEntries.length).toBe(1)
        expect(sessionEntries[0]?.id).toBe("msg-redelivery")
        // Version bumped by redelivery but no second row inserted.
        expect(sessionEntries[0]?.version).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})