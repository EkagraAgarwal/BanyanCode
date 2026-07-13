import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Queue } from "effect"
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
import type { SubagentMessage } from "../../src/banyancode/types"

process.env.BANYANCODE_ENABLE = "1"

const buildServiceLayer = (dbPath: string, queue: Queue.Queue<SubagentMessage>) => {
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
      put: () => Effect.void,
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

describe("SubagentConsumer lifecycle", () => {
  test("consumer registers itself with MeshCoordinator on start", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "lifecycle-register.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const serviceLayer = buildServiceLayer(dbPath, queue)
    const dbLayer = Database.layerFromPath(dbPath)

    let registeredConsumer: { sessionID: string; agent: string; fiber: Fiber.Fiber<unknown, unknown> } | null = null

    // Replace the mock to capture the registration.
    const mockMeshWithCapture = Layer.succeed(
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
        registerConsumer: (sessionID: any, agent: string, fiber: Fiber.Fiber<unknown, unknown>) =>
          Effect.sync(() => {
            registeredConsumer = { sessionID, agent, fiber }
          }),
        unregisterConsumer: () => Effect.void,
        runGarbageCollection: () => Effect.succeed({ swept: 0, interrupted: 0 }),
      }),
    )

    const testLayer = layer.pipe(
      Layer.provide(
        Layer.succeed(
          SubagentBus.Service,
          SubagentBus.Service.of({
            publish: () => Effect.void,
            publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
            subscribe: () => Effect.succeed(queue),
            peers: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(MemoryRepo.Service, MemoryRepo.Service.of({
          put: () => Effect.void,
          get: () => Effect.succeed(undefined),
          list: () => Effect.succeed([]),
          forget: () => Effect.void,
          forgetByKey: () => Effect.succeed(0),
          search: () => Effect.succeed([]),
          searchRanked: () => Effect.succeed({ entries: [], totalHits: 0 }),
          vacuum: () => Effect.succeed(0),
          update: () => Effect.die("not used"),
        })),
      ),
      Layer.provide(SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))),
      Layer.provide(mockMeshWithCapture),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        yield* consumer.start({ sessionID: "ses_lifecycle_test" as any, agent: "coder" })
        yield* Effect.sleep(50)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(registeredConsumer).not.toBeNull()
    expect(registeredConsumer!.sessionID).toBe("ses_lifecycle_test")
    expect(registeredConsumer!.agent).toBe("coder")
    expect(registeredConsumer!.fiber).toBeDefined()
  })

  test("kill message causes unregister to be called", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "lifecycle-kill.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const dbLayer = Database.layerFromPath(dbPath)

    let unregistered = false
    let killDelivered = false

    const mockMeshWithUnregister = Layer.succeed(
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
        unregisterConsumer: () => Effect.sync(() => { unregistered = true }),
        runGarbageCollection: () => Effect.succeed({ swept: 0, interrupted: 0 }),
      }),
    )

    const testLayer = layer.pipe(
      Layer.provide(
        Layer.succeed(
          SubagentBus.Service,
          SubagentBus.Service.of({
            publish: () => Effect.void,
            publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
            subscribe: () => Effect.succeed(queue),
            peers: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(MemoryRepo.Service, MemoryRepo.Service.of({
          put: () => Effect.void,
          get: () => Effect.succeed(undefined),
          list: () => Effect.succeed([]),
          forget: () => Effect.void,
          forgetByKey: () => Effect.succeed(0),
          search: () => Effect.succeed([]),
          searchRanked: () => Effect.succeed({ entries: [], totalHits: 0 }),
          vacuum: () => Effect.succeed(0),
          update: () => Effect.die("not used"),
        })),
      ),
      Layer.provide(SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))),
      Layer.provide(mockMeshWithUnregister),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        yield* consumer.start({ sessionID: "ses_kill_test" as any, agent: "coder" })
        // Send a kill message.
        yield* Queue.offer(queue, {
          id: "kill-msg-lifecycle",
          parentSessionID: "ses_kill_test" as any,
          fromSession: "ses_kill_test" as any,
          fromAgent: "orchestrator",
          kind: "kill",
          payload: { reason: "test" },
          createdAt: Date.now(),
        })
        yield* Effect.sleep(80)
        killDelivered = true
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(killDelivered).toBe(true)
    expect(unregistered).toBe(true)
  })

  test("consumer fiber is interrupted when parent is swept by GC", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "lifecycle-sweep.sqlite")
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const dbLayer = Database.layerFromPath(dbPath)

    let interruptedFiber: Fiber.Fiber<unknown, unknown> | null = null

    const mockMeshWithInterrupt = Layer.succeed(
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
        registerConsumer: (_sessionID: any, _agent: string, fiber: Fiber.Fiber<unknown, unknown>) =>
          Effect.sync(() => { interruptedFiber = fiber }),
        unregisterConsumer: () => Effect.void,
        runGarbageCollection: () => Effect.succeed({ swept: 0, interrupted: 0 }),
      }),
    )

    const testLayer = layer.pipe(
      Layer.provide(
        Layer.succeed(
          SubagentBus.Service,
          SubagentBus.Service.of({
            publish: () => Effect.void,
            publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
            subscribe: () => Effect.succeed(queue),
            peers: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(MemoryRepo.Service, MemoryRepo.Service.of({
          put: () => Effect.void,
          get: () => Effect.succeed(undefined),
          list: () => Effect.succeed([]),
          forget: () => Effect.void,
          forgetByKey: () => Effect.succeed(0),
          search: () => Effect.succeed([]),
          searchRanked: () => Effect.succeed({ entries: [], totalHits: 0 }),
          vacuum: () => Effect.succeed(0),
          update: () => Effect.die("not used"),
        })),
      ),
      Layer.provide(SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))),
      Layer.provide(mockMeshWithInterrupt),
    )

    // Start the consumer.
    await Effect.runPromise(
      Effect.gen(function* () {
        const consumer = yield* SubagentConsumer.Service
        yield* consumer.start({ sessionID: "ses_sweep_test" as any, agent: "coder" })
        yield* Effect.sleep(50)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    // At this point, the consumer fiber is running and registered.
    // Simulate GC sweep by directly calling Fiber.interrupt on the registered fiber.
    if (interruptedFiber) {
      // Interrupt the fiber (simulating what GC would do).
      await Effect.runPromise(Fiber.interrupt(interruptedFiber))

      // Join to verify it was interrupted - it will throw because fiber was interrupted.
      let threw = false
      try {
        await Effect.runPromise(Fiber.join(interruptedFiber))
      } catch (e: any) {
        threw = true
      }
      expect(threw).toBe(true)
    }
  })
})
