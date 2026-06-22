import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { SubagentConsumer, layer } from "../../src/banyancode/subagent-consumer"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { MemoryRepo } from "../../src/banyancode/memory-repo"
import { SubagentMessagesRepo } from "../../src/banyancode/subagent-messages-repo"
import { Database } from "../../src/database/database"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import type { MemoryEntry, SubagentMessage } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const buildServiceLayer = (dbPath: string, queue: Queue.Queue<SubagentMessage>, captured: MemoryEntry[]) => {
  const dbLayer = Database.layerFromPath(dbPath)
  const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))

  const mockBus = Layer.succeed(
    SubagentBus.Service,
    SubagentBus.Service.of({
      publish: () => Effect.void,
      subscribe: () => Effect.succeed(queue),
      peers: () => Effect.succeed([]),
    }),
  )

  const mockMemory = Layer.succeed(
    MemoryRepo.Service,
    MemoryRepo.Service.of({
      put: (input) =>
        Effect.sync(() => {
          captured.push({
            id: input.id,
            key: input.key,
            value: input.value,
            tags: input.tags ?? [],
            scope: input.scope,
            sessionID: input.sessionID,
            createdAt: input.createdAt ?? Date.now(),
          } as MemoryEntry)
        }),
      get: () => Effect.succeed(undefined),
      list: () => Effect.succeed([]),
      forget: () => Effect.void,
      forgetByKey: () => Effect.succeed(0),
      search: () => Effect.succeed([]),
      vacuum: () => Effect.succeed(0),
      update: () => Effect.die("not used"),
    }),
  )

  return layer.pipe(Layer.provide(mockBus), Layer.provide(mockMemory), Layer.provide(messagesLayer))
}

describe("SubagentConsumer", () => {
  test("start forks the loop and the loop processes a plan message into memory", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const serviceLayer = buildServiceLayer(dbPath, queue, captured)

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        yield* consumer.start(
          { sessionID: "ses_parent" as any, agent: "coder" },
          yield* Effect.scope,
        )
        yield* Queue.offer(queue, {
          id: "msg-1",
          parentSessionID: "ses_parent" as any,
          fromSession: "ses_child" as any,
          fromAgent: "coder",
          kind: "plan",
          payload: { steps: ["read", "edit", "test"] },
          createdAt: Date.now(),
        })
        yield* Effect.sleep(50)
      }).pipe(Effect.provide(serviceLayer), Effect.scoped),
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]?.key).toBe("plan:coder")
    expect(captured[0]?.value).toEqual({ steps: ["read", "edit", "test"] })
  })

  test("kill message exits the loop and the message is marked delivered", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const serviceLayer = buildServiceLayer(dbPath, queue, captured)
    const dbLayer = Database.layerFromPath(dbPath)
    const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        const messages = yield* SubagentMessagesRepo.Service
        yield* messages.put({
          id: "kill-msg",
          parentSessionID: "ses_killtest" as any,
          fromSession: "ses_killtest" as any,
          fromAgent: "coder",
          kind: "kill",
          payload: {},
          createdAt: Date.now(),
        })
        yield* consumer.start(
          { sessionID: "ses_killtest" as any, agent: "coder" },
          yield* Effect.scope,
        )
        yield* Queue.offer(queue, {
          id: "kill-msg",
          parentSessionID: "ses_killtest" as any,
          fromSession: "ses_killtest" as any,
          fromAgent: "coder",
          kind: "kill",
          payload: {},
          createdAt: Date.now(),
        })
        yield* Effect.sleep(80)
        const row = yield* messages.get("kill-msg")
        expect(row?.deliveredAt).toBeDefined()
      }).pipe(Effect.provide(serviceLayer), Effect.provide(messagesLayer), Effect.scoped),
    )
  })

  test("start returns void", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const captured: MemoryEntry[] = []
    const serviceLayer = buildServiceLayer(dbPath, queue, captured)

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        const result = yield* consumer.start(
          { sessionID: "ses_voidtest" as any, agent: "coder" },
          yield* Effect.scope,
        )
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(serviceLayer), Effect.scoped),
    )
  })
})
