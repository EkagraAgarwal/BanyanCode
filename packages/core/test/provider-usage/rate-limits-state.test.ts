import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeRateLimits } from "@opencode/core/plugin/provider/claude-agent/claude/rate-limits"

let store = ""

beforeEach(() => {
  store = join(tmpdir(), `banyancode-claude-rate-limits-${randomUUID()}.json`)
  ClaudeRateLimits.setStorePath(store)
  ClaudeRateLimits.reset()
})

afterEach(() => {
  ClaudeRateLimits.reset()
  ClaudeRateLimits.setStorePath(undefined)
})

const future = () => Math.floor(Date.now() / 1000) + 3_600

describe("Claude Agent rate-limit state", () => {
  test("an event with only unifiedWindows is recorded", () => {
    ClaudeRateLimits.record({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.51, resetsAt: future() },
        seven_day: { utilization: 91, resetsAt: future() },
      },
    } as never)

    const observed = ClaudeRateLimits.read()!
    expect(observed.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"])
    expect(observed.windows.map((window) => window.usedPercent)).toEqual([51, 91])
  })

  test("a unifiedWindows event mixed with the top-level window is recorded", () => {
    ClaudeRateLimits.record({
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: 0.42,
      resetsAt: future(),
      unifiedWindows: {
        five_hour: { utilization: 0.51, resetsAt: future() },
      },
    } as never)

    const observed = ClaudeRateLimits.read()!
    expect(observed.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"])
    expect(observed.windows.map((window) => window.usedPercent)).toEqual([51, 42])
  })

  test("the file stores numbers only", () => {
    ClaudeRateLimits.record({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.51, resetsAt: future() },
        seven_day: { utilization: 91, resetsAt: future() },
      },
    } as never)

    const state = JSON.parse(readFileSync(store, "utf8")) as {
      observedAt: number
      windows: Array<Record<string, unknown>>
    }
    expect(Object.keys(state).sort()).toEqual(["observedAt", "windows"])
    expect(state.windows).toHaveLength(2)
    for (const window of state.windows) {
      expect(Object.keys(window).every((key) => ["id", "usedPercent", "resetsAt"].includes(key))).toBe(true)
      expect(window).not.toHaveProperty("label")
      expect(window).not.toHaveProperty("durationSeconds")
    }
  })

  test("a restart reloads the last observation from the file", () => {
    ClaudeRateLimits.record({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.51, resetsAt: future() },
        seven_day: { utilization: 91, resetsAt: future() },
      },
    } as never)
    const before = ClaudeRateLimits.read()!

    ClaudeRateLimits.restart()
    const after = ClaudeRateLimits.read()!

    expect(after).toEqual(before)
    expect(after.windows.map((window) => window.label)).toEqual(["5h", "1w"])
    expect(after.windows[0]!.durationSeconds).toBe(18_000)
  })

  test("a missing file is no observation", () => {
    ClaudeRateLimits.restart()
    expect(ClaudeRateLimits.read()).toBeUndefined()
  })

  test("a corrupt file is ignored and the next event replaces it", () => {
    writeFileSync(store, "not json at all", "utf8")
    ClaudeRateLimits.restart()
    expect(ClaudeRateLimits.read()).toBeUndefined()

    ClaudeRateLimits.record({
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: future() } },
    } as never)
    expect(ClaudeRateLimits.read()!.windows[0]!.usedPercent).toBe(20)
  })

  test("the channel picks an isolated file name", () => {
    expect(ClaudeRateLimits.storeFileName("latest", {})).toBe("claude-agent-rate-limits.json")
    expect(ClaudeRateLimits.storeFileName("beta", {})).toBe("claude-agent-rate-limits.json")
    expect(ClaudeRateLimits.storeFileName("prod", {})).toBe("claude-agent-rate-limits.json")
    expect(ClaudeRateLimits.storeFileName("dev", {})).toBe("claude-agent-rate-limits-dev.json")
    expect(ClaudeRateLimits.storeFileName("dev", { OPENCODE_DISABLE_CHANNEL_DB: "1" })).toBe(
      "claude-agent-rate-limits.json",
    )
  })
})
