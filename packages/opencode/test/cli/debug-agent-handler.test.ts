import { expect, test } from "bun:test"
import { parseToolParams } from "../../src/cli/cmd/debug/agent.handler"

test("parses JSON tool params", () => {
  expect(parseToolParams('{"enabled":true,"count":2}')).toEqual({ enabled: true, count: 2 })
})

test("rejects executable JavaScript tool params", () => {
  expect(() => parseToolParams("({ enabled: process.exit() })")).toThrow("Use a JSON object")
})
