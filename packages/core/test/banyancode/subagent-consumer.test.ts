import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { SubagentConsumer, layer } from "../../src/banyancode/subagent-consumer"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { MemoryRepo } from "../../src/banyancode/memory-repo"
import { SubagentMessagesRepo } from "../../src/banyancode/subagent-messages-repo"
import { MeshCoordinator } from "../../src/banyancode/mesh-coordinator"
import { SubagentPlans } from "../../src/banyancode/subagent-plans-repo"
import { EventV2 } from "../../src/event"
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
      publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
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
      searchRanked: () => Effect.succeed({ entries: [], totalHits: 0 }),
      vacuum: () => Effect.succeed(0),
      update: () => Effect.die("not used"),
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

  return layer.pipe(
    Layer.provide(mockBus),
    Layer.provide(mockMemory),
    Layer.provide(messagesLayer),
    Layer.provide(mockPlans),
    Layer.provide(mockMesh),
  )
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
        yield* consumer.start({ sessionID: "ses_parent" as any, agent: "coder" })
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
        yield* consumer.start({ sessionID: "ses_killtest" as any, agent: "coder" })
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
        const result = yield* consumer.start({ sessionID: "ses_voidtest" as any, agent: "coder" })
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(serviceLayer), Effect.scoped),
    )
  })
})
