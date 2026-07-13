export * as NestedSpawnRegistry from "./nested-spawn-registry"

import { Context, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { SessionSchema } from "../session/schema"
import { MAX_NESTED_EXPLORE_PER_CODER, MAX_NESTED_EXPLORE_LIFETIME_PER_CODER } from "./max-subagents"

export class NestedSpawnBudgetExceededError extends Schema.TaggedErrorClass<NestedSpawnBudgetExceededError>()(
  "Banyan/NestedSpawnBudgetExceededError",
  {
    error: Schema.Union([Schema.Literal("concurrent"), Schema.Literal("lifetime")]),
  },
) {}

interface ChildEntry {
  fiber: Fiber.Fiber<unknown, unknown>
}

interface ParentEntry {
  concurrent: number
  lifetime: number
  children: Map<string, ChildEntry>
}

export interface Interface {
  readonly tryReserveSlot: (
    parentSessionID: SessionSchema.ID,
  ) => Effect.Effect<{ ok: true } | { ok: false; error: "concurrent" | "lifetime" }, never, never>
  readonly registerFiber: (
    parentSessionID: SessionSchema.ID,
    childSessionID: SessionSchema.ID,
    fiber: Fiber.Fiber<unknown, unknown>,
  ) => Effect.Effect<void>
  readonly unregisterFiber: (
    parentSessionID: SessionSchema.ID,
    childSessionID: SessionSchema.ID,
  ) => Effect.Effect<void>
  readonly interruptAll: (parentSessionID: SessionSchema.ID) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/NestedSpawnRegistry") {}

const DEBUG = process.env.BANYANCODE_DEBUG === "mesh"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<Map<string, ParentEntry>>(new Map())

    const tryReserveSlot = Effect.fn("NestedSpawnRegistry.tryReserveSlot")(function* (
      parentSessionID: SessionSchema.ID,
    ) {
      const pid = parentSessionID as string
      let result: { ok: true } | { ok: false; error: "concurrent" | "lifetime" } = { ok: true }

      yield* Ref.update(state, (map) => {
        const entry = map.get(pid)
        if (!entry) {
          map.set(pid, { concurrent: 1, lifetime: 1, children: new Map() })
          return map
        }
        if (entry.concurrent >= MAX_NESTED_EXPLORE_PER_CODER) {
          result = { ok: false, error: "concurrent" }
          return map
        }
        if (entry.lifetime >= MAX_NESTED_EXPLORE_LIFETIME_PER_CODER) {
          result = { ok: false, error: "lifetime" }
          return map
        }
        entry.concurrent++
        entry.lifetime++
        return map
      })

      if (DEBUG) {
        yield* Effect.logDebug(`NestedSpawnRegistry.tryReserveSlot(${pid})`, { result })
      }
      return result
    })

    const registerFiber = Effect.fn("NestedSpawnRegistry.registerFiber")(function* (
      parentSessionID: SessionSchema.ID,
      childSessionID: SessionSchema.ID,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) {
      const pid = parentSessionID as string
      const cid = childSessionID as string

      yield* Ref.update(state, (map) => {
        const entry = map.get(pid)
        if (entry) {
          entry.children.set(cid, { fiber })
        }
        return map
      })

      if (DEBUG) {
        yield* Effect.logDebug(`NestedSpawnRegistry.registerFiber(${pid}, ${cid})`)
      }
      return Effect.void
    })

    const unregisterFiber = Effect.fn("NestedSpawnRegistry.unregisterFiber")(function* (
      parentSessionID: SessionSchema.ID,
      childSessionID: SessionSchema.ID,
    ) {
      const pid = parentSessionID as string
      const cid = childSessionID as string

      yield* Ref.update(state, (map) => {
        const entry = map.get(pid)
        if (entry) {
          entry.children.delete(cid)
          entry.concurrent = Math.max(0, entry.concurrent - 1)
        }
        return map
      })

      if (DEBUG) {
        yield* Effect.logDebug(`NestedSpawnRegistry.unregisterFiber(${pid}, ${cid})`)
      }
      return Effect.void
    })

    const interruptAll = Effect.fn("NestedSpawnRegistry.interruptAll")(function* (parentSessionID: SessionSchema.ID) {
      const pid = parentSessionID as string
      let count = 0

      const entry = yield* Ref.get(state).pipe(Effect.map((map) => map.get(pid)))

      if (entry) {
        for (const child of entry.children.values()) {
          yield* Fiber.interrupt(child.fiber).pipe(Effect.ignore)
          count++
        }
      }

      yield* Ref.update(state, (map) => {
        map.delete(pid)
        return map
      })

      if (DEBUG) {
        yield* Effect.logDebug(`NestedSpawnRegistry.interruptAll(${pid})`, { count })
      }
      return count
    })

    return Service.of({ tryReserveSlot, registerFiber, unregisterFiber, interruptAll })
  }),
)

export const defaultLayer = layer
