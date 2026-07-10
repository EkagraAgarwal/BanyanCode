import { describe, expect, test } from "bun:test"

describe("prompt footer", () => {
  test("does not render usage / context% / cost in normal mode", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../src/component/prompt/index.tsx"),
      "utf8",
    )
    expect(source).not.toMatch(/<Match when=\{usage\(\)\}/)
    expect(source).not.toMatch(/item\(\)\.context/)
    expect(source).not.toMatch(/item\(\)\.cost/)
    expect(source).not.toMatch(/const usage = createMemo/)
  })

  test("keeps keybind and slash-command hints in normal mode", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../src/component/prompt/index.tsx"),
      "utf8",
    )
    expect(source).toContain("agents")
    expect(source).toContain("commands")
    expect(source).toContain("/agents  /graph  /memory  /theme")
    expect(source).toContain("switch tab")
  })
})