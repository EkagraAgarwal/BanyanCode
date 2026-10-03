import { expect, test } from "bun:test"

test("console-mode enforcer polls at 1s, not 100ms", () => {
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../src/terminal-win32.ts"),
    "utf8",
  )
  expect(source).toContain("setInterval(enforce, 1000)")
  expect(source).not.toContain("setInterval(enforce, 100)")
})
