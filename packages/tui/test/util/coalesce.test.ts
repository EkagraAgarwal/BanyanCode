import { describe, expect, test } from "bun:test"
import { coalesceMsForLength, decideCoalesceFlush, PART_RENDER_COALESCE_MS } from "../../src/util/signal"

describe("decideCoalesceFlush", () => {
  test("flushes immediately when flushNow is true", () => {
    expect(
      decideCoalesceFlush({
        flushNow: true,
        lastFlush: 1000,
        now: 1010,
        ms: 50,
        timerPending: true,
      }),
    ).toEqual({ action: "flush" })
  })

  test("flushes on leading edge after a quiet window", () => {
    expect(
      decideCoalesceFlush({
        flushNow: false,
        lastFlush: 0,
        now: 1000,
        ms: 50,
        timerPending: false,
      }),
    ).toEqual({ action: "flush" })
  })

  test("schedules when inside the coalesce window", () => {
    expect(
      decideCoalesceFlush({
        flushNow: false,
        lastFlush: 1000,
        now: 1020,
        ms: 50,
        timerPending: false,
      }),
    ).toEqual({ action: "schedule", delayMs: 30 })
  })

  test("skips when a timer is already pending", () => {
    expect(
      decideCoalesceFlush({
        flushNow: false,
        lastFlush: 1000,
        now: 1020,
        ms: 50,
        timerPending: true,
      }),
    ).toEqual({ action: "skip" })
  })
})
describe("coalesceMsForLength", () => {
  test("small parts render at the trailing-batch interval", () => {
    expect(coalesceMsForLength(0)).toBe(PART_RENDER_COALESCE_MS)
    expect(coalesceMsForLength(4096)).toBe(PART_RENDER_COALESCE_MS)
  })

  test("huge outputs back off monotonically", () => {
    const mid = coalesceMsForLength(16_384)
    const large = coalesceMsForLength(65_536)
    const huge = coalesceMsForLength(1_000_000)
    expect(mid).toBeGreaterThan(PART_RENDER_COALESCE_MS)
    expect(large).toBeGreaterThanOrEqual(mid)
    expect(huge).toBeGreaterThanOrEqual(large)
  })
})
