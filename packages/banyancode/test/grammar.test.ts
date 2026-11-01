import { expect, test } from "bun:test"
import { probe } from "../src/grammar.js"

test("tree-sitter runtime and typescript grammar load from plugin assets", async () => {
  const result = await probe()
  expect(result.rootType).toBe("program")
  expect(result.hasError).toBe(false)
  expect(result.wasmPath.length).toBeGreaterThan(0)
})
