import { describe, expect, test } from "bun:test"
import { resolveAbsoluteLatest, shouldSkipUpgrade } from "../../src/installation/compare"

describe("resolveAbsoluteLatest", () => {
  test("prefers the dev tag when its core is newer", () => {
    expect(resolveAbsoluteLatest("26.8.12-dev.abc1234", "26.8.11")).toBe("26.8.12-dev.abc1234")
  })

  test("prefers the stable tag when its core is strictly greater", () => {
    expect(resolveAbsoluteLatest("26.8.11-dev.abc1234", "26.8.12")).toBe("26.8.12")
  })

  test("prefers the dev tag on an equal base", () => {
    expect(resolveAbsoluteLatest("26.8.11-dev.abc1234", "26.8.11")).toBe("26.8.11-dev.abc1234")
  })

  test("treats leading-zero cores as equal (26.08.11 == 26.8.11) and prefers dev on the tie", () => {
    expect(resolveAbsoluteLatest("26.08.11-dev.5013cc3", "26.8.11")).toBe("26.08.11-dev.5013cc3")
  })

  test("treats a leading-zero stable core as strictly greater (26.8.11 < 26.08.12)", () => {
    expect(resolveAbsoluteLatest("26.8.11", "26.08.12")).toBe("26.08.12")
  })

  test("falls back to the stable tag when the dev fetch fails", () => {
    expect(resolveAbsoluteLatest(undefined, "26.8.11")).toBe("26.8.11")
  })

  test("falls back to the dev tag when the stable fetch fails", () => {
    expect(resolveAbsoluteLatest("26.8.11-dev.abc1234", undefined)).toBe("26.8.11-dev.abc1234")
  })

  test("throws when both fetches fail", () => {
    expect(() => resolveAbsoluteLatest(undefined, undefined)).toThrow()
  })
})

describe("shouldSkipUpgrade", () => {
  test("upgrades when the installed canary sha differs from the published one (regression: 5013cc3 vs 1dd17c0)", () => {
    expect(shouldSkipUpgrade("26.08.11-dev.5013cc3", "26.8.11-dev.1dd17c0")).toBe(false)
  })

  test("skips when already on the exact published canary", () => {
    expect(shouldSkipUpgrade("26.8.11-dev.1dd17c0", "26.8.11-dev.1dd17c0")).toBe(true)
  })

  test("upgrades on a higher stable base version", () => {
    expect(shouldSkipUpgrade("26.8.10", "26.8.11")).toBe(false)
  })

  test("skips downgrades on a lower stable base version", () => {
    expect(shouldSkipUpgrade("26.8.12", "26.8.11")).toBe(true)
  })

  test("skips downgrades between canaries with different base versions", () => {
    expect(shouldSkipUpgrade("26.8.12-dev.abc1234", "26.8.11-dev.xyz9876")).toBe(true)
  })

  test("handles leading-zero base versions identically (26.08 == 26.8)", () => {
    expect(shouldSkipUpgrade("26.08.11-dev.5013cc3", "26.8.11-dev.5013cc3")).toBe(true)
  })

  test("skips when the baked leading-zero version equals the registry form (26.07.4 == 26.7.4)", () => {
    expect(shouldSkipUpgrade("26.07.4", "26.7.4")).toBe(true)
  })

  test("upgrades same-base canaries with different shas even across leading-zero forms", () => {
    expect(shouldSkipUpgrade("26.07.4-dev.5013cc3", "26.7.4-dev.1dd17c0")).toBe(false)
  })
})
