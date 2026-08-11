import { describe, expect, test } from "bun:test"
import { placeholderScript } from "../../script/install-placeholder"

const unixPlatforms = ["linux", "darwin"] as const

describe("placeholderScript", () => {
  test("linux/darwin placeholders start with a sh shebang", () => {
    for (const platform of unixPlatforms) {
      const script = placeholderScript(platform)
      expect(script.startsWith("#!/bin/sh\n"), platform).toBe(true)
    }
  })

  test("win32 placeholder has no shebang and exits with an error", () => {
    const script = placeholderScript("win32")
    expect(script.startsWith("#!")).toBe(false)
    expect(script).toContain("exit 1")
  })

  test("all platforms carry allow-scripts and manual postinstall guidance", () => {
    const platforms: NodeJS.Platform[] = [...unixPlatforms, "win32"]
    for (const platform of platforms) {
      const script = placeholderScript(platform)
      expect(script, platform).toContain("--allow-scripts")
      expect(script, platform).toContain("node postinstall.mjs")
    }
  })
})
