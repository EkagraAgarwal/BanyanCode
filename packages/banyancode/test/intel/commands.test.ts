import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import {
  REPOSITORY_COMMAND_NAMES,
  REPOSITORY_COMMANDS,
  commandText,
  registerCommands,
} from "../../src/intel/commands.js"

interface Command {
  readonly name: string
  readonly description?: string
  readonly execute: (input: {
    readonly sessionID: string
    readonly prompt: { readonly text: string }
    readonly delivery: "steer"
  }) => Effect.Effect<void, unknown>
}

const harness = () => {
  const commands: Command[] = []
  const prompts: { text: string; delivery: string }[] = []
  const ctx = {
    command: {
      transform: (fn: (editor: { add: (definition: Command) => void }) => void) =>
        Effect.sync(() => {
          fn({ add: (definition) => commands.push(definition) })
        }),
    },
    session: {
      prompt: (input: { text: string; delivery: string }) =>
        Effect.sync(() => {
          prompts.push({ text: input.text, delivery: input.delivery })
          return {}
        }),
    },
  } as unknown as Context
  return { ctx, commands, prompts }
}

const execute = (command: Command, text: string) =>
  Effect.runPromise(
    command.execute({ sessionID: "session-1", prompt: { text }, delivery: "steer" }) as Effect.Effect<void>,
  )

describe("/repository-* slash commands (v1 parity)", () => {
  test("registers all eight v1 commands", async () => {
    const h = harness()
    await Effect.runPromise(Effect.scoped(registerCommands(h.ctx)))
    expect(h.commands.map((command) => command.name)).toEqual([...REPOSITORY_COMMAND_NAMES])
    for (const command of h.commands) {
      expect(command.description?.length ?? 0).toBeGreaterThan(20)
    }
  })

  test("execute sends the v1 template plus the arguments as a prompt", async () => {
    const h = harness()
    await Effect.runPromise(Effect.scoped(registerCommands(h.ctx)))
    const explain = h.commands.find((command) => command.name === "repository-explain")!
    await execute(explain, "MySymbol")

    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.text).toContain("Usage: /repository-explain <symbol>")
    expect(h.prompts[0]!.text.endsWith("MySymbol")).toBe(true)
    expect(h.prompts[0]!.delivery).toBe("steer")
  })

  test("template text is preserved byte-for-byte from v1", () => {
    const query = REPOSITORY_COMMANDS.find((command) => command.name === "repository-query")!
    expect(query.template).toContain("--limit: maximum number of recent commits to include (optional, default 10)")
    expect(commandText(query.template, "")).toBe(query.template)
    expect(commandText(query.template, "auth")).toContain("If the codegraph has not been built yet")
  })
})
