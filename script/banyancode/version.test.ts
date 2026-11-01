import { describe, expect, test } from "bun:test"
import {
  CALVER,
  channelForVersion,
  compareCalVer,
  devVersion,
  isCalVer,
  readBaseVersion,
  resolveVersion,
  V1_LAST_VERSION,
} from "./version"
import { PLATFORMS, UMBRELLA } from "./platforms"

describe("CalVer", () => {
  test("accepts YY.MM.PATCH and rejects prefixes", () => {
    expect(isCalVer("26.11.0")).toBe(true)
    expect(isCalVer("26.10.10")).toBe(true)
    expect(isCalVer("v26.11.0")).toBe(false)
    expect(isCalVer("26.11")).toBe(false)
    expect(isCalVer("26.11.0-dev.abc1234")).toBe(false)
    expect(CALVER.test("26.11.0")).toBe(true)
  })

  test("compares numerically, not lexically", () => {
    expect(compareCalVer("26.10.10", "26.10.9")).toBeGreaterThan(0)
    expect(compareCalVer("26.11.0", "26.10.9")).toBeGreaterThan(0)
    expect(compareCalVer("26.10.2", "26.10.10")).toBeLessThan(0)
    expect(compareCalVer("26.11.0", "26.11.0")).toBe(0)
  })

  test("the base version continues after v1's last release", () => {
    // readBaseVersion validates the shape; this pins the continuity rule.
    return readBaseVersion().then((version) => {
      expect(compareCalVer(version, V1_LAST_VERSION)).toBeGreaterThan(0)
    })
  })
})

describe("channels", () => {
  test("maps suffixes to npm dist-tags", () => {
    expect(channelForVersion("26.11.0")).toBe("latest")
    expect(channelForVersion("26.11.1")).toBe("latest")
    expect(channelForVersion("26.11.0-dev.abc1234")).toBe("dev")
    expect(channelForVersion("26.11.0-rc.1")).toBe("next")
    expect(channelForVersion("26.11.0-beta.2")).toBe("next")
  })

  test("dev versions append a 7-char sha", () => {
    expect(devVersion("26.11.0", "abc1234")).toBe("26.11.0-dev.abc1234")
    expect(() => devVersion("v26.11.0", "abc1234")).toThrow()
  })
})

describe("resolveVersion", () => {
  test("latest returns the bare CalVer", () => {
    expect(resolveVersion({ channel: "latest", base: "26.11.0" })).toBe("26.11.0")
    expect(resolveVersion({ base: "26.11.0" })).toBe("26.11.0")
  })

  test("dev replaces an existing dev suffix instead of stacking it", () => {
    const first = resolveVersion({ channel: "dev", base: "26.11.0", sha: "abc1234" })
    expect(first).toBe("26.11.0-dev.abc1234")
    expect(resolveVersion({ channel: "dev", version: first, sha: "def5678" })).toBe("26.11.0-dev.def5678")
  })

  test("dev rejects a non-CalVer base", () => {
    expect(() => resolveVersion({ channel: "dev", version: "1.2.3", sha: "abc1234" })).toThrow()
  })
})

describe("platforms", () => {
  test("covers every v1 target plus windows-arm64", () => {
    const targets = PLATFORMS.map((entry) => entry.target)
    for (const target of [
      "linux-x64",
      "linux-x64-baseline",
      "linux-x64-musl",
      "linux-x64-baseline-musl",
      "linux-arm64",
      "linux-arm64-musl",
      "darwin-x64",
      "darwin-x64-baseline",
      "darwin-arm64",
      "windows-x64",
      "windows-x64-baseline",
      "windows-arm64",
    ]) {
      expect(targets).toContain(target)
    }
    expect(new Set(targets).size).toBe(targets.length)
  })

  test("the Windows baseline build is npm-only", () => {
    const baseline = PLATFORMS.find((entry) => entry.target === "windows-x64-baseline")
    expect(baseline?.shipping).toBe(false)
    expect(PLATFORMS.filter((entry) => entry.shipping)).toHaveLength(PLATFORMS.length - 1)
  })

  test("npm names are unscoped and prefixed with the umbrella name", () => {
    for (const entry of PLATFORMS) {
      expect(entry.npm).toBe(`${UMBRELLA}-${entry.target}`)
      expect(entry.npm.startsWith("@")).toBe(false)
    }
  })
})
