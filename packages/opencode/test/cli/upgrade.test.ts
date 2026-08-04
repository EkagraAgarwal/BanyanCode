import { describe, expect, test } from "bun:test"
import { shouldSkipUpgrade } from "../../src/cli/cmd/upgrade"

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
})
