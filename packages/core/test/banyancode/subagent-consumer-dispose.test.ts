import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Queue } from "effect"
import { SubagentConsumer, layer as consumerLayer } from "../../src/banyancode/subagent-consumer"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { MemoryRepo } from "../../src/banyancode/memory-repo"
import { SubagentMessagesRepo } from "../../src/banyancode/subagent-messages-repo"
import { MeshCoordinator, layer as meshLayer } from "../../src/banyancode/mesh-coordinator"
import { SubagentPlans } from "../../src/banyancode/subagent-plans-repo"
import { SubagentReviewRequests } from "../../src/banyancode/subagent-review-requests-repo"
import { EventV2 } from "../../src/event"
import { Database } from "../../src/database/database"
import { SessionSchema } from "../../src/session/schema"
import type { SubagentMessage } from "../../src/banyancode/types"
import { tmpdir } from "../fixture/tmpdir"
import { makeSubagentBusMockLayer } from "../lib/subagent-bus"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const sid = (s: string) => SessionSchema.ID.make(s) as SessionSchema.ID

const mockMemory = Layer.succeed(
  MemoryRepo.Service,
  MemoryRepo.Service.of({
    put: () => Effect.void,
    get: () => Effect.succeed(undefined),
    resolveRootSessionID: (sessionID) => Effect.succeed(sessionID),
    getLatestSessionScoped: () => Effect.succeed(undefined),
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
    setStepStatus: () => Effect.succeed(undefined),
  }),
)

const mockReviews = Layer.succeed(
  SubagentReviewRequests.Service,
  SubagentReviewRequests.Service.of({
    put: () => Effect.void,
    getByID: () => Effect.succeed(undefined),
    listByParent: () => Effect.succeed([]),
    listPending: () => Effect.succeed([]),
    markDispatched: () => Effect.void,
    markCompleted: () => Effect.void,
    markFailed: () => Effect.void,
  }),
)

const killMessage = (parent: SessionSchema.ID, agent: string): SubagentMessage => ({
  id: crypto.randomUUID(),
  parentSessionID: parent,
  fromSession: parent,
  fromAgent: "orchestrator",
  toAgent: agent,
  kind: "kill",
  payload: { reason: "test-dispose" },
  createdAt: Date.now(),
})

describe("SubagentConsumer dispose convergence", () => {
  test("kill drains through the single finalizer: queue shut, consumer unregistered, GC sweeps to zero", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "dispose-kill.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const mockBus = makeSubagentBusMockLayer(queue)
    const messagesLayer = SubagentMessagesRepo.defaultLayer.pipe(Layer.provide(dbLayer))
    const mesh = meshLayer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockPlans),
      Layer.provide(mockReviews),
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(dbLayer),
    )

    // Capture the consumer fiber while delegating to the real mesh, so the
    // test can join it deterministically instead of sleeping.
    let consumerFiber: Fiber.Fiber<unknown, unknown> | null = null
    const meshWithCapture = Layer.effect(
      MeshCoordinator.Service,
      Effect.gen(function* () {
        const real = yield* MeshCoordinator.Service
        return MeshCoordinator.Service.of({
          ...real,
          registerConsumer: (sessionID, agent, fiber) =>
            Effect.sync(() => {
              consumerFiber = fiber
            }).pipe(Effect.andThen(real.registerConsumer(sessionID, agent, fiber))),
        })
      }),
    ).pipe(Layer.provide(mesh))

    const consumer = consumerLayer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockMemory),
      Layer.provide(messagesLayer),
      Layer.provide(mockPlans),
      Layer.provide(meshWithCapture),
    )
    const testLayer = Layer.mergeAll(dbLayer, mesh, meshWithCapture, consumer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const starter = yield* SubagentConsumer.Service
        const coordinator = yield* MeshCoordinator.Service
        const parent = sid("ses_dispose_kill")

        yield* starter.start({ sessionID: parent, agent: "coder" })
        expect(consumerFiber).not.toBeNull()
        yield* Queue.offer(queue, killMessage(parent, "coder"))

        // Join resolves only after the loop's finally ran: the single
        // finalizer shut the queue and unregistered the consumer.
        yield* Fiber.join(consumerFiber!)

        // Zero surviving queue: the shut queue refuses further offers.
        expect(yield* Queue.offer(queue, killMessage(parent, "coder"))).toBe(false)
        // Shutdown is idempotent — a second call completes without error.
        yield* Queue.shutdown(queue)

        // Finish disposal through the mesh: end the parent, sweep, and
        // confirm zero surviving consumers; repeat sweeps are no-ops.
        yield* coordinator.markParentEnded(parent)
        const swept = yield* coordinator.runGarbageCollection()
        expect(swept.swept).toBe(1)
        expect(yield* coordinator.listTrackedParents()).toEqual([])
        const resweep = yield* coordinator.runGarbageCollection()
        expect(resweep).toEqual({ swept: 0, interrupted: 0 })

        // Unregistering an already-removed consumer is a no-op.
        yield* coordinator.unregisterConsumer(parent, "coder")
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    )
  })

  test("GC interrupts every registered fiber: zero survivors, repeat sweep is a no-op", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "dispose-fibers.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const queue = await Effect.runPromise(Queue.unbounded<SubagentMessage>())
    const mockBus = makeSubagentBusMockLayer(queue)
    const mesh = meshLayer.pipe(
      Layer.provide(mockBus),
      Layer.provide(mockPlans),
      Layer.provide(mockReviews),
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(dbLayer),
    )
    const testLayer = Layer.mergeAll(dbLayer, mesh)

    const fibers = await Effect.runPromise(
      Effect.gen(function* () {
        const coordinator = yield* MeshCoordinator.Service
        const parent = sid("ses_dispose_fibers")

        const first = yield* Effect.forkDetach(Effect.never)
        const second = yield* Effect.forkDetach(Effect.never)
        yield* coordinator.registerConsumer(parent, "coder", first)
        yield* coordinator.registerConsumer(parent, "scout", second)

        yield* coordinator.markParentEnded(parent)
        const swept = yield* coordinator.runGarbageCollection()
        expect(swept).toEqual({ swept: 1, interrupted: 2 })
        expect(yield* coordinator.listTrackedParents()).toEqual([])

        const resweep = yield* coordinator.runGarbageCollection()
        expect(resweep).toEqual({ swept: 0, interrupted: 0 })

        return [first, second] as const
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    )

    // Zero surviving fibers: joining an interrupted fiber throws.
    for (const fiber of fibers) {
      let threw = false
      try {
        await Effect.runPromise(Fiber.join(fiber))
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    }
  })
})
