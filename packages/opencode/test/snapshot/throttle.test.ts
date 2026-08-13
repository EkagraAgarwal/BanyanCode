import { describe, expect, test } from "bun:test"
import { Snapshot } from "../../src/snapshot"

const { shouldThrottle, isUnstableSourceError } = Snapshot.__test

describe("Snapshot.__test.shouldThrottle", () => {
  test("never throttles a first run (lastRun undefined)", () => {
    expect(shouldThrottle(undefined, 5_000, 1_000)).toBe(false)
  })

  test("throttles when now is inside the min interval", () => {
    expect(shouldThrottle(1_000, 1_999, 1_000)).toBe(true)
  })

  test("does not throttle exactly at the interval boundary", () => {
    expect(shouldThrottle(1_000, 2_000, 1_000)).toBe(false)
  })

  test("does not throttle once the interval has elapsed", () => {
    expect(shouldThrottle(1_000, 2_001, 1_000)).toBe(false)
  })
})

describe("Snapshot.__test.isUnstableSourceError", () => {
  test("matches the unstable object source data fatal", () => {
    expect(isUnstableSourceError("fatal: confused by unstable object source data")).toBe(true)
  })

  test("matches index-pack failure variants", () => {
    expect(isUnstableSourceError("error: index-pack failed")).toBe(true)
    expect(isUnstableSourceError("fatal: index-pack died")).toBe(true)
  })

  test("ignores unrelated git failures", () => {
    expect(isUnstableSourceError("fatal: Unable to create '...' : Permission denied")).toBe(false)
    expect(isUnstableSourceError("fatal: pathspec 'foo' did not match any files")).toBe(false)
    expect(isUnstableSourceError("")).toBe(false)
  })
})
