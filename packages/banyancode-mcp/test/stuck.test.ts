import { describe, expect, test } from "bun:test"
import { detectStuck, suggestCheckupSeconds } from "../src/stuck"

describe("detectStuck", () => {
  test("running with no durable progress past the threshold", () => {
    const stuck = detectStuck({ status: "running", lastEventAt: 1_000, now: 1_000 + 6 * 60_000 })
    expect(stuck?.kind).toBe("no_progress")
    expect(stuck?.detail).toContain("360s")
  })

  test("fresh progress is not stuck", () => {
    expect(detectStuck({ status: "running", lastEventAt: 9_000, now: 10_000 })).toBeUndefined()
  })

  test("waiting for input, queued and terminal states are never stuck", () => {
    const now = 1_000_000
    expect(detectStuck({ status: "needs_input", lastEventAt: 1, now })).toBeUndefined()
    expect(detectStuck({ status: "queued", lastEventAt: 1, now })).toBeUndefined()
    expect(detectStuck({ status: "done", lastEventAt: 1, now })).toBeUndefined()
    expect(detectStuck({ status: "failed", lastEventAt: 1, now })).toBeUndefined()
  })

  test("a repeating identical tool call is a loop", () => {
    const stuck = detectStuck({
      status: "running",
      lastEventAt: 9_000,
      now: 10_000,
      recentToolCalls: ["a:edit", "b:read", "c:edit", "c:edit", "c:edit"],
    })
    expect(stuck?.kind).toBe("loop")
    expect(stuck?.detail).toContain("3 times")
  })

  test("two repeats stay below the default threshold", () => {
    expect(
      detectStuck({ status: "running", lastEventAt: 9_000, now: 10_000, recentToolCalls: ["x:edit", "x:edit"] }),
    ).toBeUndefined()
  })

  test("a loop ending in something else is not flagged", () => {
    expect(
      detectStuck({
        status: "running",
        lastEventAt: 9_000,
        now: 10_000,
        recentToolCalls: ["x:edit", "x:edit", "x:edit", "y:read"],
      }),
    ).toBeUndefined()
  })
})

describe("suggestCheckupSeconds", () => {
  test("terminal tasks need no next checkup", () => {
    expect(suggestCheckupSeconds({ status: "done", now: 0 })).toBeUndefined()
    expect(suggestCheckupSeconds({ status: "failed", now: 0 })).toBeUndefined()
  })

  test("blocked, stuck and active tasks get different intervals", () => {
    expect(suggestCheckupSeconds({ status: "needs_input", now: 0 })).toBe(30)
    expect(
      suggestCheckupSeconds({ status: "running", now: 0, stuck: { kind: "loop", detail: "", repeats: 3 } }),
    ).toBe(60)
    expect(suggestCheckupSeconds({ status: "running", now: 10_000, lastEventAt: 9_000 })).toBe(20)
    expect(suggestCheckupSeconds({ status: "running", now: 100_000, lastEventAt: 1_000 })).toBe(45)
    expect(suggestCheckupSeconds({ status: "running", now: 1_000_000, lastEventAt: 1_000 })).toBe(60)
  })
})
