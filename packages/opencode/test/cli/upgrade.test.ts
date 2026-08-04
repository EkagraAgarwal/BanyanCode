import { describe, expect, test } from "bun:test"
import { shouldAutoInstall } from "../../src/cli/upgrade"
import { shouldSkipUpgrade } from "../../src/cli/cmd/upgrade"

describe("shouldAutoInstall", () => {
  test("stable channel auto-installs patch releases", () => {
    expect(shouldAutoInstall("latest", "patch", undefined)).toBe(true)
  })

  test("stable channel only notifies on minor releases", () => {
    expect(shouldAutoInstall("latest", "minor", undefined)).toBe(false)
  })

  test("dev channel auto-installs minor releases", () => {
    expect(shouldAutoInstall("dev", "minor", undefined)).toBe(true)
  })

  test("dev channel auto-installs major releases", () => {
    expect(shouldAutoInstall("dev", "major", undefined)).toBe(true)
  })

  test('autoupdate "notify" never auto-installs', () => {
    expect(shouldAutoInstall("dev", "patch", "notify")).toBe(false)
    expect(shouldAutoInstall("latest", "patch", "notify")).toBe(false)
  })
})

describe("shouldSkipUpgrade (re-exported from cli/cmd/upgrade)", () => {
  test("skips when the baked leading-zero version equals the registry form (26.07.4 == 26.7.4)", () => {
    expect(shouldSkipUpgrade("26.07.4", "26.7.4")).toBe(true)
  })

  test("upgrades same-base canaries with different shas", () => {
    expect(shouldSkipUpgrade("26.07.4-dev.5013cc3", "26.7.4-dev.1dd17c0")).toBe(false)
  })
})
