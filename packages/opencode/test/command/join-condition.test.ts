import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Command, joinCondition } from "../../src/command"

process.env.BANYANCODE_ENABLE = "0"

describe("joinCondition", () => {
  test("preserves multi-word conditions and drops recognized flags", () => {
    // parseArgs already consumes `--priority high` into flags, so positional
    // here is what survives after parseArgs.
    const out = joinCondition({
      positional: [
        "implement",
        "a",
        "real-time",
        "notification",
        "badge",
        "in",
        "the",
        "TUI",
      ],
      flags: { priority: "high" },
    })
    expect(out).toBe("implement a real-time notification badge in the TUI")
  })

  test("supports --flag=value form without double-stripping", () => {
    // parseArgs strips `--priority=normal` and `--plan=./docs/plan.md`
    // into flags. The condition is the remainder.
    const out = joinCondition({
      positional: ["ship", "a", "working", "editor"],
      flags: { priority: "normal", plan: "./docs/plan.md" },
    })
    expect(out).toBe("ship a working editor")
  })

  test("empty input yields empty output", () => {
    expect(joinCondition({ positional: [], flags: {} })).toBe("")
  })

  test("drops the `--` argument separator", () => {
    expect(joinCondition({ positional: ["--", "ship", "a"], flags: {} })).toBe("ship a")
  })

  test("drops stray --flag=value tokens for known flags (defensive)", () => {
    // In practice parseArgs already removed these; verify joinCondition
    // is safe if positional somehow still carries them.
    const out = joinCondition({
      positional: ["ship", "--priority=normal", "an", "editor"],
      flags: {},
    })
    expect(out).toBe("ship an editor")
  })
})

describe("Command.Info.execute return contract", () => {
  test("terminal shape type-checks", () => {
    const info: Command.Info = {
      name: "synthetic",
      source: "command",
      template: "ignored",
      execute: () => Effect.succeed({ kind: "terminal" as const, message: "ok" }),
      hints: [],
    }
    expect(info.execute).toBeDefined()
  })

  test("continue shape type-checks", () => {
    const info: Command.Info = {
      name: "synthetic",
      source: "command",
      template: "ignored",
      execute: () => Effect.succeed({ kind: "continue" as const }),
      hints: [],
    }
    expect(info.execute).toBeDefined()
  })
})