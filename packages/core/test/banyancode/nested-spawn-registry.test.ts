import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import {
  Service as NestedSpawnRegistryService,
  defaultLayer,
} from "../../src/banyancode/nested-spawn-registry"
import { MAX_NESTED_EXPLORE_PER_CODER, MAX_NESTED_EXPLORE_LIFETIME_PER_CODER } from "../../src/banyancode/max-subagents"
import { SessionSchema } from "../../src/session/schema"

const testLayer = defaultLayer

const makeSessionID = (n: number): SessionSchema.ID => SessionSchema.ID.make(`ses_test_${n}`) as SessionSchema.ID

describe("NestedSpawnRegistry", () => {
  test("reserve slot below cap returns ok", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* NestedSpawnRegistryService
        const sessionID = makeSessionID(1)

        // First reservation should succeed
        const result = yield* svc.tryReserveSlot(sessionID)
        expect(result.ok).toBe(true)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("reserve slot when at concurrent cap returns error concurrent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* NestedSpawnRegistryService
        const sessionID = makeSessionID(2)

        // Reserve up to concurrent cap
        for (let i = 0; i < MAX_NESTED_EXPLORE_PER_CODER; i++) {
          const result = yield* svc.tryReserveSlot(sessionID)
          expect(result.ok).toBe(true)
        }

        // One more should fail with concurrent error
        const result = yield* svc.tryReserveSlot(sessionID)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toBe("concurrent")
        }
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("reserve slot when at lifetime cap returns error lifetime", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* NestedSpawnRegistryService
          const sessionID = makeSessionID(3)

          // Reserve and unregister multiple times to test lifetime cap
          // With concurrent=1, we need to unregister to make room for the next
          for (let i = 0; i < MAX_NESTED_EXPLORE_LIFETIME_PER_CODER; i++) {
            const result = yield* svc.tryReserveSlot(sessionID)
            expect(result.ok).toBe(true)
            // Unregister to free up the concurrent slot
            const childID = SessionSchema.ID.make(`ses_child_${i}`) as SessionSchema.ID
            const fiber = yield* Effect.forkDetach(Effect.void)
            yield* svc.registerFiber(sessionID, childID, fiber)
            yield* svc.unregisterFiber(sessionID, childID)
          }

          // Lifetime is exhausted, next reservation should fail with lifetime error
          const result = yield* svc.tryReserveSlot(sessionID)
          expect(result.ok).toBe(false)
          if (!result.ok) {
            expect(result.error).toBe("lifetime")
          }
        }),
      ).pipe(Effect.provide(testLayer)),
    )
  })

  test("interruptAll clears entry and returns count", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* NestedSpawnRegistryService
          const parentID = makeSessionID(4)
          const childID = makeSessionID(100)

          // Reserve a slot
          yield* svc.tryReserveSlot(parentID)

          // Create a fiber and register it
          const dummyFiber = yield* Effect.forkDetach(Effect.void)
          yield* svc.registerFiber(parentID, childID, dummyFiber)

          // interruptAll should return count and clear
          const count = yield* svc.interruptAll(parentID)
          expect(count).toBe(1)

          // After interruptAll, the entry should be gone
          // Trying to reserve should succeed (new entry)
          const result = yield* svc.tryReserveSlot(parentID)
          expect(result.ok).toBe(true)
        }),
      ).pipe(Effect.provide(testLayer)),
    )
  })

  test("registerFiber and unregisterFiber work correctly", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* NestedSpawnRegistryService
          const parentID = makeSessionID(5)
          const childID1 = makeSessionID(101)
          const childID2 = makeSessionID(102)

          // Reserve slots for two children
          yield* svc.tryReserveSlot(parentID)
          yield* svc.tryReserveSlot(parentID)

          // Create fibers
          const fiber1 = yield* Effect.forkDetach(Effect.void)
          const fiber2 = yield* Effect.forkDetach(Effect.void)

          yield* svc.registerFiber(parentID, childID1, fiber1)
          yield* svc.registerFiber(parentID, childID2, fiber2)

          // Unregister one fiber
          yield* svc.unregisterFiber(parentID, childID1)

          // interruptAll should only interrupt the remaining fiber
          const count = yield* svc.interruptAll(parentID)
          expect(count).toBe(1)
        }),
      ).pipe(Effect.provide(testLayer)),
    )
  })
})
