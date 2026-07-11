import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { SubagentConsumer, layer } from "@opencode-ai/core/banyancode/subagent-consumer"
import { SubagentBus } from "@opencode-ai/core/banyancode/subagent-bus"
import { MemoryRepo } from "@opencode-ai/core/banyancode/memory-repo"
import { SubagentMessagesRepo } from "@opencode-ai/core/banyancode/subagent-messages-repo"
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
      subscribe: () => Effect.succeed(queue),
      peers: () => Effect.succeed([]),
    }),
  )

  // Real MemoryRepo + SubagentMessagesRepo against the test DB; mock SubagentBus.
  // Provide them in the order the consumer's internal layer expects.
  const memoryLayer = Banyan.memoryRepoDefaultLayer.pipe(Layer.provide(dbLayer))
  const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))
  const consumerLayer = layer.pipe(
    Layer.provide(mockBus),
    Layer.provide(memoryLayer),
    Layer.provide(messagesLayer),
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