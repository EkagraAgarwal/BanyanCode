import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { targetConfigFile } from "../../src/config/index.js"
import { parseJsonc } from "../../src/config/jsonc.js"
import { MAX_SUBAGENTS_COMMAND, SWARM_COMMAND, parseSwarmCommand, registerCommands } from "../../src/mesh/commands.js"
import type { MeshService } from "../../src/mesh/service.js"
import type { SessionPort } from "../../src/mesh/session-port.js"

const withTemp = async (fn: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-mesh-commands-"))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

interface Command {
  readonly name: string
  readonly execute: (input: { sessionID: string; prompt: { text: string } }) => Effect.Effect<void, unknown>
}

const harness = (directory: string) => {
  const commands: Command[] = []
  const synthetic: string[] = []
  let swarmMode = false
  const mesh = {
    limits: () => Effect.succeed({ swarmMode, maxSubagents: 5, backgroundSubagents: true }),
    setSwarmMode: (on: boolean) =>
      Effect.sync(() => {
        swarmMode = on
        return { swarmMode, maxSubagents: 5, backgroundSubagents: true }
      }),
    snapshotMap: () => Effect.succeed(new Map()),
    live: { pipe: () => undefined },
  } as unknown as MeshService
  const sessions = {
    synthetic: (input: { text: string }) =>
      Effect.sync(() => {
        synthetic.push(input.text)
        return {}
      }),
  } as unknown as SessionPort
  const ctx = {
    location: { directory, project: { directory, canonical: directory } },
    command: {
      transform: (fn: (editor: { add: (definition: Command) => void }) => void) =>
        Effect.sync(() => fn({ add: (definition) => commands.push(definition) })),
    },
    permission: { assert: () => Effect.void },
  } as unknown as Context
  return { ctx, commands, synthetic, mesh, sessions, swarm: () => swarmMode }
}

const execute = (command: Command, text = "") =>
  Effect.runPromise(command.execute({ sessionID: "ses_1", prompt: { text } }) as Effect.Effect<void>)

describe("mesh commands", () => {
  test("registers /swarm and /max-subagents", async () => {
    await withTemp(async (directory) => {
      const h = harness(directory)
      await Effect.runPromise(Effect.scoped(registerCommands(h.ctx, { mesh: h.mesh, sessions: h.sessions })))
      expect(h.commands.map((command) => command.name)).toEqual([SWARM_COMMAND, MAX_SUBAGENTS_COMMAND])
    })
  })

  test("/swarm with no args persists banyancode_swarm_mode through the writer", async () => {
    await withTemp(async (directory) => {
      const h = harness(directory)
      await Effect.runPromise(Effect.scoped(registerCommands(h.ctx, { mesh: h.mesh, sessions: h.sessions })))
      await execute(h.commands.find((command) => command.name === SWARM_COMMAND)!)

      expect(h.swarm()).toBe(true)
      expect(h.synthetic.at(-1)).toBe("Swarm mode is now on.")
      // `/swarm` writes the global config (v1 behavior); the test process's
      // XDG_CONFIG_HOME is a throwaway dir from test/preload.ts.
      const file = await targetConfigFile({ directory, projectRoot: directory })
      expect(parseJsonc(await readFile(file, "utf8"))).toEqual({ banyancode_swarm_mode: true })

      // Toggling again persists the opposite value, not just the in-memory ref.
      await execute(h.commands.find((command) => command.name === SWARM_COMMAND)!)
      expect(parseJsonc(await readFile(file, "utf8"))).toEqual({ banyancode_swarm_mode: false })
    })
  })

  test("v1 /swarm argument parsing is preserved", () => {
    expect(parseSwarmCommand("", { available: 3 })).toEqual({ mode: "toggle" })
    expect(parseSwarmCommand("fix tests", { available: 3 })).toMatchObject({
      mode: "spawn",
      count: 3,
      agent: "coder",
      task: "fix tests",
    })
    expect(parseSwarmCommand("x --agents 9", { available: 2 })).toMatchObject({ count: 2, clamped: true })
    expect(parseSwarmCommand("x --agent reviewer", { available: 2 })).toMatchObject({ agent: "reviewer" })
    expect(parseSwarmCommand("x --bogus", { available: 2 })).toMatchObject({ mode: "error" })
  })
})
