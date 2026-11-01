import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BanyanConfig } from "../../src/config/index.js"
import type { Storage } from "../../src/storage/index.js"
import { register } from "../../src/system/index.js"

interface RegisteredRpc {
  readonly definition: { readonly id: string; readonly methods: Record<string, unknown>; readonly events: Record<string, unknown> }
  readonly handlers: Record<string, unknown>
}

const makeContext = (directory: string) => {
  const tools: Tool.Info[] = []
  const rpc: RegisteredRpc[] = []
  const commands: string[] = []
  const synthetic: string[] = []
  const ctx = {
    app: { name: "banyancode", version: "26.10.9", channel: "latest" },
    location: {
      directory,
      project: { canonical: directory, directory, id: "project-1" },
    },
    tool: {
      transform: (fn: (editor: unknown) => void) =>
        Effect.sync(() => {
          fn({
            namespace: () => {},
            add: (tool: Tool.Info) => {
              tools.push(tool)
            },
          })
        }),
      list: () => Effect.succeed(tools),
    },
    rpc: {
      register: (definition: RegisteredRpc["definition"], handlers: RegisteredRpc["handlers"]) =>
        Effect.sync(() => {
          rpc.push({ definition, handlers })
          return { events: { emit: () => Effect.void } }
        }),
    },
    command: {
      transform: (fn: (editor: { add: (command: { name: string }) => void }) => void) =>
        Effect.sync(() =>
          fn({
            add: (command) => {
              commands.push(command.name)
            },
          }),
        ),
    },
    session: {
      synthetic: (input: { text: string }) =>
        Effect.sync(() => {
          synthetic.push(input.text)
          return {}
        }),
      prompt: () => Effect.void,
    },
    agent: { reload: () => Effect.void },
    permission: { assert: () => Effect.void },
  }
  return { ctx: ctx as unknown as Context, tools, rpc, commands, synthetic }
}

const storage = {
  query: () => Effect.succeed([]),
} as unknown as Storage.Interface

describe("system register", () => {
  test("registers the system tools, RPC and workstream 3e commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "banyancode-system-register-"))
    try {
      const harness = makeContext(directory)
      const config = BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })
      await Effect.runPromise(Effect.scoped(register(harness.ctx, { storage, config })))

      expect(harness.tools.map((tool) => tool.name).sort()).toEqual(["banyan_tool_search", "system_status", "systeminfo"])
      expect(harness.rpc).toHaveLength(1)
      expect(harness.rpc[0]!.definition.id).toBe("banyancode.system")
      expect(Object.keys(harness.rpc[0]!.handlers).sort()).toEqual(
        Object.keys(harness.rpc[0]!.definition.methods).sort(),
      )
      expect(harness.commands).toEqual(["yolo", "lsp", "websearch-free", "max-subagents"])
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
