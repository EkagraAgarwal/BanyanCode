import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Service as NestedSpawnRegistryService } from "@opencode-ai/core/banyancode/nested-spawn-registry"
import { defaultLayer as nestedSpawnLayer } from "@opencode-ai/core/banyancode/nested-spawn-registry"
import { MAX_NESTED_EXPLORE_LIFETIME_PER_CODER } from "@opencode-ai/core/banyancode/max-subagents"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "../lib/effect"
import { Config } from "@/config/config"

const testLayer = Layer.mergeAll(Config.defaultLayer, nestedSpawnLayer)
const it = testEffect(testLayer)

const makeSessionID = (n: number): SessionSchema.ID => SessionSchema.ID.make(`ses_test_${n}`) as SessionSchema.ID

describe("task nested explore cap", () => {
  it.live(
    "6th task: explore from same coder returns NestedSpawnBudgetExceededError",
    () =>
      Effect.gen(function* () {
        const registry = yield* NestedSpawnRegistryService
        const parentID = makeSessionID(1)

        // Spawn MAX_NESTED_EXPLORE_LIFETIME_PER_CODER explores
        for (let i = 0; i < MAX_NESTED_EXPLORE_LIFETIME_PER_CODER; i++) {
          const reserveResult = yield* registry.tryReserveSlot(parentID)
          expect(reserveResult.ok).toBe(true)

          // Register a fiber and immediately unregister (simulating explore completion)
          const childID = makeSessionID(100 + i)
          const fiber = yield* Effect.forkDetach(Effect.void)
          yield* registry.registerFiber(parentID, childID, fiber)
          yield* registry.unregisterFiber(parentID, childID)
        }

        // 6th attempt should fail with lifetime error
        const result = yield* registry.tryReserveSlot(parentID)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toBe("lifetime")
        }
      }),
  )

  it.live(
    "reserve slot fails with concurrent error when at concurrent cap",
    () =>
      Effect.gen(function* () {
        const registry = yield* NestedSpawnRegistryService
        const parentID = makeSessionID(2)

        // Reserve up to concurrent cap without unregistering
        for (let i = 0; i < 1; i++) {
          const result = yield* registry.tryReserveSlot(parentID)
          expect(result.ok).toBe(true)
        }

        // Next attempt should fail with concurrent error
        const result = yield* registry.tryReserveSlot(parentID)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toBe("concurrent")
        }
      }),
  )
})
