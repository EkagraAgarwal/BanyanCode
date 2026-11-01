import { describe, expect, test } from "bun:test"
import { evaluateBudget, parseBudget } from "../src/budget"

describe("parseBudget", () => {
  test("defaults steps and inherits the configured USD cap", () => {
    expect(parseBudget(undefined, { maxCost: 3 })).toEqual({ maxSteps: 200, maxCost: 3, timeoutMs: 0 })
  })

  test("per-start caps win, invalid values fall back", () => {
    expect(parseBudget({ max_steps: 10, max_cost: 0.5, timeout_s: 90 }, { maxCost: 3 })).toEqual({
      maxSteps: 10,
      maxCost: 0.5,
      timeoutMs: 90_000,
    })
    expect(parseBudget({ max_steps: -1, max_cost: Number.NaN, timeout_s: 0 }, { maxCost: 3 })).toEqual({
      maxSteps: 200,
      maxCost: 3,
      timeoutMs: 0,
    })
  })
})

describe("evaluateBudget", () => {
  const budget = { maxSteps: 5, maxCost: 1, timeoutMs: 60_000 }
  const usage = (overrides: Partial<{ steps: number; cost: number; now: number }> = {}) => ({
    steps: 0,
    cost: 0,
    startedAt: 0,
    now: 0,
    ...overrides,
  })

  test("under every cap", () => {
    expect(evaluateBudget(budget, usage({ steps: 5, cost: 1, now: 60_000 }))).toBeUndefined()
  })

  test("step cap", () => {
    const trip = evaluateBudget(budget, usage({ steps: 6 }))
    expect(trip?.reason).toBe("steps")
  })

  test("cost cap", () => {
    const trip = evaluateBudget(budget, usage({ cost: 1.01 }))
    expect(trip?.reason).toBe("cost")
    expect(trip?.detail).toContain("1.0100")
  })

  test("timeout cap", () => {
    const trip = evaluateBudget(budget, usage({ now: 60_001 }))
    expect(trip?.reason).toBe("timeout")
  })

  test("a zero timeout disables the wall clock dimension", () => {
    expect(evaluateBudget({ ...budget, timeoutMs: 0 }, usage({ now: 10_000_000 }))).toBeUndefined()
  })
})
