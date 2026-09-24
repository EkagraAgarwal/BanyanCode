import { describe, expect, test } from "bun:test"
import { decideCoalesceFlush } from "../../src/util/signal"

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
