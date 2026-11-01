import { expect, test } from "bun:test"
import { builtins } from "../src/plugin/builtins"

test("builtins register the BanyanCode TUI plugin", () => {
  const plugin = builtins.find((entry) => entry.id === "banyancode.tui")
  expect(plugin).toBeDefined()
  expect(typeof plugin?.setup).toBe("function")
})
