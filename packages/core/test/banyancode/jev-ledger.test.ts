import { beforeEach, describe, expect, test } from "bun:test"
import { JevLedger } from "../../src/banyancode/jev-ledger"

beforeEach(() => {
  JevLedger.resetForTests()
})

describe("JevLedger", () => {
  test("unknown sessions snapshot to zeros", () => {
    expect(JevLedger.snapshot("ghost")).toMatchObject({
      sessionID: "ghost",
      requests: 0,
      cachedHits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      estimatedCost: 0,
    })
  })

  test("attempts count once; reported usage and estimates stay separate", () => {
    JevLedger.reserveCall("s1", { feature: "judge", scope: "turn" })
    JevLedger.recordAttempt("s1")
    JevLedger.recordAttempt("s1")
    JevLedger.recordUsage("s1", { inputTokens: 100, outputTokens: 10, cost: 0.02 })
    JevLedger.recordCacheHit("s1", { feature: "judge" })
    expect(JevLedger.snapshot("s1")).toMatchObject({
      requests: 2,
      cachedHits: 1,
      inputTokens: 100,
      outputTokens: 10,
      cost: 0.02,
      estimatedCost: 0,
    })
    expect(JevLedger.scopeCount("s1", "turn")).toBe(1)
    expect(JevLedger.sessionCost("s1")).toBe(0.02)
  })

  test("cost reservation is atomic against the cap", () => {
    expect(JevLedger.reserveCost("cap", 0.5, 1)).toBe(true)
    expect(JevLedger.reserveCost("cap", 0.6, 1)).toBe(false)
    expect(JevLedger.reserveCost("cap", 0.5, 1)).toBe(true)
    // Reserves are pending only; estimated spend stays separate.
    expect(JevLedger.snapshot("cap")).toMatchObject({ estimatedCost: 0, pendingCost: 1 })
    expect(JevLedger.sessionSpend("cap")).toBe(1)
    expect(JevLedger.reserveCost("open", 5, undefined)).toBe(true)
  })

  test("release frees pending without touching estimated spend", () => {
    expect(JevLedger.reserveCost("rel", 0.4, 1)).toBe(true)
    JevLedger.releaseCost("rel", 0.4)
    expect(JevLedger.snapshot("rel")).toMatchObject({ estimatedCost: 0, pendingCost: 0 })
    expect(JevLedger.sessionSpend("rel")).toBe(0)
    // Over-release floors at zero.
    JevLedger.releaseCost("rel", 1)
    expect(JevLedger.snapshot("rel").pendingCost).toBe(0)
    // Cap accounts for actual + estimated + pending.
    JevLedger.recordEstimatedSpend("rel", 0.6, { reservedCost: 0 })
    expect(JevLedger.reserveCost("rel", 0.5, 1)).toBe(false)
    expect(JevLedger.reserveCost("rel", 0.4, 1)).toBe(true)
  })

  test("reported cost never double-counts with estimates", () => {
    expect(JevLedger.reserveCost("mix", 0.3, 10)).toBe(true)
    JevLedger.recordUsage("mix", { inputTokens: 10, outputTokens: 2, cost: 0.05, reservedCost: 0.3 })
    expect(JevLedger.snapshot("mix")).toMatchObject({ cost: 0.05, estimatedCost: 0, pendingCost: 0 })
    expect(JevLedger.sessionSpend("mix")).toBeCloseTo(0.05, 12)
  })

  test("tokens-only usage derives estimated spend and frees pending", () => {
    expect(JevLedger.reserveCost("tok", 0.2, 10)).toBe(true)
    JevLedger.recordUsage("tok", { inputTokens: 100, outputTokens: 5, estimatedCost: 0.01, reservedCost: 0.2 })
    expect(JevLedger.snapshot("tok")).toMatchObject({ estimatedCost: 0.01, pendingCost: 0 })
    expect(JevLedger.sessionSpend("tok")).toBeCloseTo(0.01, 12)
  })

  test("session retention is bounded", () => {
    for (let index = 0; index < JevLedger.MAX_SESSIONS + 100; index += 1) {
      JevLedger.reserveCall(`session-${index}`, { scope: "turn" })
    }
    expect(JevLedger.sessionCountForTests()).toBeLessThanOrEqual(JevLedger.MAX_SESSIONS)
    expect(JevLedger.snapshot(`session-${JevLedger.MAX_SESSIONS + 99}`)).toMatchObject({ scopes: { turn: 1 } })
  })

  test("per-session feature and scope maps are bounded", () => {
    for (let index = 0; index < 200; index += 1) {
      JevLedger.reserveCall("crowded", { feature: `feature-${index}`, scope: `scope-${index}` })
    }
    const snap = JevLedger.snapshot("crowded")
    expect(Object.keys(snap.features).length).toBeLessThanOrEqual(JevLedger.MAX_FEATURES_PER_SESSION)
    expect(Object.keys(snap.scopes).length).toBeLessThanOrEqual(JevLedger.MAX_SCOPES_PER_SESSION)
  })
})
