import { describe, expect, test } from "bun:test"
import { createTimeoutTracker } from "../../src/util/timers"

describe("createTimeoutTracker", () => {
  test("scheduled callback fires", async () => {
    const tracker = createTimeoutTracker()
    let fired = 0
    tracker.later(5, () => {
      fired += 1
    })
    expect(tracker.size).toBe(1)
    await Bun.sleep(25)
    expect(fired).toBe(1)
    expect(tracker.size).toBe(0)
  })

  test("dispose prevents pending callbacks (unmount cleanup)", async () => {
    const tracker = createTimeoutTracker()
    let fired = 0
    tracker.later(5, () => {
      fired += 1
    })
    tracker.later(5, () => {
      fired += 1
    })
    expect(tracker.size).toBe(2)
    tracker.dispose()
    expect(tracker.size).toBe(0)
    await Bun.sleep(25)
    expect(fired).toBe(0)
  })

  test("clear cancels a single timer without touching the rest", async () => {
    const tracker = createTimeoutTracker()
    let first = 0
    let second = 0
    const id = tracker.later(5, () => {
      first += 1
    })
    tracker.later(5, () => {
      second += 1
    })
    tracker.clear(id)
    await Bun.sleep(25)
    expect(first).toBe(0)
    expect(second).toBe(1)
    expect(tracker.size).toBe(0)
  })
})
