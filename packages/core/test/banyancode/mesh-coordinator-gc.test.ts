import { describe, expect, test } from "bun:test"
import { Effect, Layer, Queue } from "effect"
import { MeshCoordinator, layer } from "../../src/banyancode/mesh-coordinator"
import { SubagentBus } from "../../src/banyancode/subagent-bus"
import { SubagentPlans } from "../../src/banyancode/subagent-plans-repo"
import { EventV2 } from "../../src/event"
import { Database } from "../../src/database/database"
import type { SubagentMessage } from "../../src/banyancode/types"
import { SessionSchema } from "../../src/session/schema"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"

process.env.BANYANCODE_ENABLE = "1"

const sid = (s: string) => SessionSchema.ID.make(s) as SessionSchema.ID

const buildServiceLayer = (dbPath: string) => {
  const dbLayer = Database.layerFromPath(dbPath)

  const mockBus = Layer.succeed(
    SubagentBus.Service,
    SubagentBus.Service.of({
      publish: () => Effect.void,
      publishOrFetch: (msg) => Effect.succeed({ id: msg.id, createdAt: msg.createdAt, created: true }),
      subscribe: () => Effect.succeed({} as unknown as Queue.Dequeue<SubagentMessage>),
      peers: () => Effect.succeed([]),
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

  const meshLayer = layer.pipe(
    Layer.provide(mockBus),
    Layer.provide(mockPlans),
    Layer.provide(EventV2.defaultLayer),
    Layer.provide(dbLayer),
  )

  return meshLayer
}

describe("MeshCoordinator GC", () => {
  test("GC sweep marks parent ended and interrupts its fiber; returns swept=1 and interrupted=N", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "gc-sweep-test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = buildServiceLayer(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const mesh = yield* MeshCoordinator.Service

        // Register a parent with a "long-running" fiber (simulated via Effect.never).
        const fakeFiber = yield* Effect.forkDetach(Effect.never)

        yield* mesh.registerConsumer(sid("ses_gc_sweep"), "coder", fakeFiber)

        // GC should not sweep because status is active and lastSeenAt is recent.
        const resultBefore = yield* mesh.runGarbageCollection()
        expect(resultBefore.swept).toBe(0)
        expect(resultBefore.interrupted).toBe(0)

        // Mark the parent as ended so GC will sweep it.
        yield* mesh.markParentEnded(sid("ses_gc_sweep"))

        // GC should now sweep the entry and interrupt the fiber.
        const resultAfter = yield* mesh.runGarbageCollection()
        expect(resultAfter.swept).toBe(1)
        expect(resultAfter.interrupted).toBe(1)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("GC is a no-op when there are no tracked parents", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "gc-noop-test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = buildServiceLayer(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const mesh = yield* MeshCoordinator.Service

        // No parents registered — GC should be a no-op.
        const result = yield* mesh.runGarbageCollection()
        expect(result.swept).toBe(0)
        expect(result.interrupted).toBe(0)
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

  test("registerConsumer and unregisterConsumer do not throw", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "register-test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const serviceLayer = buildServiceLayer(dbPath)

    await Effect.runPromise(
      Effect.gen(function* () {
        const mesh = yield* MeshCoordinator.Service

        const fakeFiber = yield* Effect.forkDetach(Effect.never)

        // Should not throw.
        yield* mesh.registerConsumer(sid("ses_register_test"), "coder", fakeFiber)
        yield* mesh.unregisterConsumer(sid("ses_register_test"), "coder")
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})
