import { describe, expect, test } from "bun:test"
import { Command } from "@/command"

process.env.BANYANCODE_ENABLE = "1"

// Test that verifies the command registry structure without requiring Effect runtime
describe("command execute", () => {
  test("agent-model and embedding-model are NOT in Default constants", () => {
    // These commands should have been removed from the Default export
    // The TUI dialog implementations in app.tsx are the single source of truth
    const keys = Object.keys(Command.Default)
    expect(keys).not.toContain("AGENT_MODEL")
    expect(keys).not.toContain("EMBEDDING_MODEL")
  })

  test("codegraph-build and code-embed ARE in Default constants", () => {
    expect(Command.Default.CODEGRAPH_BUILD).toBe("codegraph-build")
    expect(Command.Default.CODE_EMBED).toBe("code-embed")
  })

  test("init and review ARE in Default constants", () => {
    expect(Command.Default.INIT).toBe("init")
    expect(Command.Default.REVIEW).toBe("review")
  })

  test("Default has exactly 6 commands (init, review, codegraph-build, code-embed, yolo, refresh-models)", () => {
    const keys = Object.keys(Command.Default)
    expect(keys).toHaveLength(6)
    expect(keys).toContain("INIT")
    expect(keys).toContain("REVIEW")
    expect(keys).toContain("CODEGRAPH_BUILD")
    expect(keys).toContain("CODE_EMBED")
    expect(keys).toContain("YOLO")
    expect(keys).toContain("REFRESH_MODELS")
  })
})
