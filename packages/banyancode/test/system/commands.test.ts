import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BanyanConfig } from "../../src/config/index.js"
import { parseJsonc } from "../../src/config/jsonc.js"
import {
  LSP_COMMAND,
  MAX_SUBAGENTS_COMMAND,
  WEBSEARCH_FREE_COMMAND,
  YOLO_COMMAND,
  registerCommands,
} from "../../src/system/commands.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-system-commands-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

interface Command {
  readonly name: string
  readonly description?: string
  readonly execute: (input: { readonly sessionID: string; readonly prompt: { readonly text: string } }) => Effect.Effect<void, unknown>
}

const harness = () => {
  const commands: Command[] = []
  const synthetic: string[] = []
  const prompts: string[] = []
  const ctx = {
    command: {
      transform: (fn: (editor: { add: (definition: Command) => void }) => void) =>
        Effect.sync(() => fn({ add: (definition) => commands.push(definition) })),
    },
    session: {
      synthetic: (input: { text: string }) =>
        Effect.sync(() => {
          synthetic.push(input.text)
          return {}
        }),
      prompt: (input: { text: string }) =>
        Effect.sync(() => {
          prompts.push(input.text)
          return {}
        }),
    },
  } as unknown as Context
  return { ctx, commands, synthetic, prompts }
}

const execute = (command: Command | undefined, text = "") => {
  expect(command).toBeDefined()
  return Effect.runPromise(
    command!.execute({ sessionID: "session-1", prompt: { text } }) as Effect.Effect<void>,
  )
}

describe("system slash commands", () => {
  test("registerCommands adds the four workstream 3e commands", async () => {
    await withTemp(async (directory) => {
      const { ctx, commands } = harness()
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })
      await Effect.runPromise(
        Effect.scoped(
          registerCommands(ctx, {
            config,
            target: { globalDir: directory, directory, projectRoot: directory },
            session: ctx.session,
            maxSubagentsLimit: 20,
            maxSubagentsDefault: 5,
          }),
        ),
      )
      expect(commands.map((command) => command.name)).toEqual([
        YOLO_COMMAND,
        LSP_COMMAND,
        WEBSEARCH_FREE_COMMAND,
        MAX_SUBAGENTS_COMMAND,
      ])
      expect(commands.every((command) => command.description?.length)).toBe(true)
    })
  })

  test("/yolo persists the toggle and reports state", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "banyancode.json")
      await writeFile(file, '{\n  // keep\n  "banyancode_yolo_mode": false\n}\n')
      const { ctx, commands, synthetic } = harness()
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })
      await Effect.runPromise(
        Effect.scoped(
          registerCommands(ctx, {
            config,
            target: { globalDir: directory, directory, projectRoot: directory },
            session: ctx.session,
            maxSubagentsLimit: 20,
            maxSubagentsDefault: 5,
          }),
        ),
      )
      await execute(commands.find((command) => command.name === YOLO_COMMAND))
      expect(synthetic.at(-1)).toBe("YOLO mode is now on.")
      expect(parseJsonc(await readFile(file, "utf8"))).toMatchObject({ banyancode_yolo_mode: true })
      expect(await readFile(file, "utf8")).toContain("// keep")

      await execute(commands.find((command) => command.name === YOLO_COMMAND), "off")
      expect(synthetic.at(-1)).toBe("YOLO mode is now off.")
    })
  })

  test("/lsp persists on/off and prints current when called bare", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "banyancode.json")
      await writeFile(file, "{}\n")
      const { ctx, commands, synthetic } = harness()
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })
      await Effect.runPromise(
        Effect.scoped(
          registerCommands(ctx, {
            config,
            target: { globalDir: directory, directory, projectRoot: directory },
            session: ctx.session,
            maxSubagentsLimit: 20,
            maxSubagentsDefault: 5,
          }),
        ),
      )
      const lsp = commands.find((command) => command.name === LSP_COMMAND)
      await execute(lsp)
      expect(synthetic.at(-1)).toContain("BanyanCode LSP is off")
      await execute(lsp, "on")
      expect(parseJsonc(await readFile(file, "utf8"))).toMatchObject({ banyancode_lsp: true })
      expect(synthetic.at(-1)).toBe("BanyanCode LSP is now on.")
      await execute(lsp, "nonsense")
      expect(synthetic.at(-1)).toContain('Unknown argument "nonsense"')
    })
  })

  test("/max-subagents validates and persists 1-20", async () => {
    await withTemp(async (directory) => {
      const file = join(directory, "banyancode.json")
      await writeFile(file, "{}\n")
      const { ctx, commands, synthetic } = harness()
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })
      await Effect.runPromise(
        Effect.scoped(
          registerCommands(ctx, {
            config,
            target: { globalDir: directory, directory, projectRoot: directory },
            session: ctx.session,
            maxSubagentsLimit: 20,
            maxSubagentsDefault: 5,
          }),
        ),
      )
      const max = commands.find((command) => command.name === MAX_SUBAGENTS_COMMAND)
      await execute(max, "7")
      expect(synthetic.at(-1)).toBe("Max subagents set to 7.")
      expect(parseJsonc(await readFile(file, "utf8"))).toMatchObject({ banyancode_max_subagents: 7 })
      await execute(max, "99")
      expect(synthetic.at(-1)).toContain("between 1 and 20")
      await execute(max)
      expect(synthetic.at(-1)).toContain("Max subagents is 7.")
    })
  })

  test("/websearch-free injects the v1 template plus the query", async () => {
    await withTemp(async (directory) => {
      const { ctx, commands, prompts } = harness()
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })
      await Effect.runPromise(
        Effect.scoped(
          registerCommands(ctx, {
            config,
            target: { globalDir: directory, directory, projectRoot: directory },
            session: ctx.session,
            maxSubagentsLimit: 20,
            maxSubagentsDefault: 5,
          }),
        ),
      )
      await execute(commands.find((command) => command.name === WEBSEARCH_FREE_COMMAND), "latest bun release")
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("Search the web using DuckDuckGo HTML.")
      expect(prompts[0]).toContain("latest bun release")
    })
  })
})
