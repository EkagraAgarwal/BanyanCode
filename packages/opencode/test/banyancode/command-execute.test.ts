import { describe, expect, test } from "bun:test"
import { Command } from "@/command"

process.env.BANYANCODE_ENABLE = "1"

// Test that verifies the command registry structure without requiring Effect runtime
describe("command execute", () => {
  test("agent-model is NOT in Default constants", () => {
    const keys = Object.keys(Command.Default)
    expect(keys).not.toContain("AGENT_MODEL")
  })

  test("codegraph-build IS in Default constants", () => {
    expect(Command.Default.CODEGRAPH_BUILD).toBe("codegraph-build")
  })

  test("init and review ARE in Default constants", () => {
    expect(Command.Default.INIT).toBe("init")
    expect(Command.Default.REVIEW).toBe("review")
  })

  test("Default has exactly 6 commands (init, review, codegraph-build, codegraph-remove, yolo, refresh-models)", () => {
    const keys = Object.keys(Command.Default)
    expect(keys).toHaveLength(6)
    expect(keys).toContain("INIT")
    expect(keys).toContain("REVIEW")
    expect(keys).toContain("CODEGRAPH_BUILD")
    expect(keys).toContain("CODEGRAPH_REMOVE")
    expect(keys).toContain("YOLO")
    expect(keys).toContain("REFRESH_MODELS")
    expect(keys).not.toContain("CODE_EMBED")
  })
})
