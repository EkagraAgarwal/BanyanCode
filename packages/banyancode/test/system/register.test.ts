import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BanyanConfig } from "../../src/config/index.js"
import type { Storage } from "../../src/storage/index.js"
import type { SystemMonitor, SystemStatus } from "../../src/system/monitor.js"
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
  const events: SystemStatus[] = []
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
          return {
            dispose: Effect.void,
            events: {
              emit: (name: string, status: SystemStatus) =>
                Effect.sync(() => {
                  if (name === "updated") events.push(status)
                }),
            },
          }
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
  return { ctx: ctx as unknown as Context, tools, rpc, commands, synthetic, events }
}

const storage = {
  query: () => Effect.succeed([]),
} as unknown as Storage.Interface

/** A deterministic sampler: call numbers, with optional hard failures per call. */
const fakeMonitor = (options: { readonly failOn?: ReadonlySet<number> } = {}) => {
  let calls = 0
  const monitor: SystemMonitor = {
    status: async () => {
      calls += 1
      if (options.failOn?.has(calls) === true) throw new Error(`probe failed on call ${calls}`)
      return {
        cpuPercent: calls,
        memoryUsedBytes: calls,
        memoryTotalBytes: 1_000,
        platform: "linux",
      }
    },
  }
  return { monitor, calls: () => calls }
}

const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "banyancode-system-register-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const configFor = (directory: string) =>
  BanyanConfig.make({ directory, projectRoot: directory, globalDir: directory })

describe("system register", () => {
  test("registers the system tools, RPC and workstream 3e commands", () =>
    withDirectory(async (directory) => {
      const harness = makeContext(directory)
      await Effect.runPromise(
        Effect.scoped(
          register(harness.ctx, { storage, config: configFor(directory), monitor: fakeMonitor().monitor }),
        ),
      )

      expect(harness.tools.map((tool) => tool.name).sort()).toEqual(["banyan_tool_search", "system_status", "systeminfo"])
      expect(harness.rpc).toHaveLength(1)
      expect(harness.rpc[0]!.definition.id).toBe("banyancode.system")
      expect(Object.keys(harness.rpc[0]!.handlers).sort()).toEqual(
        Object.keys(harness.rpc[0]!.definition.methods).sort(),
      )
      expect(harness.commands).toEqual(["yolo", "lsp", "websearch-free", "max-subagents"])
    }))

  test("primes the sampler so the first status already has a CPU delta", () =>
    withDirectory(async (directory) => {
      const harness = makeContext(directory)
      const sampler = fakeMonitor()
      await Effect.runPromise(
        Effect.scoped(register(harness.ctx, { storage, config: configFor(directory), monitor: sampler.monitor })),
      )
      // One best-effort sample at registration: CPU is a delta, so without it
      // the first TUI read and the first publish report no percentage at all.
      expect(sampler.calls()).toBe(1)
    }))

  test("publishes on the cadence after registration returns and survives a throwing sample", () =>
    withDirectory(async (directory) => {
      const harness = makeContext(directory)
      // Call 1 primes; calls 2, 3 and 5 throw. The stream must keep going.
      const sampler = fakeMonitor({ failOn: new Set([2, 3, 5]) })
      const scope = await Effect.runPromise(Scope.make())
      try {
        await Effect.runPromise(
          register(harness.ctx, {
            storage,
            config: configFor(directory),
            monitor: sampler.monitor,
            statusInterval: "10 millis",
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        )
        // `register` has returned, which is where the old forked loop could die.
        await Bun.sleep(150)

        expect(sampler.calls()).toBeGreaterThanOrEqual(5)
        expect(harness.events.length).toBeGreaterThanOrEqual(3)
        expect(harness.events.every((status) => status.cpuPercent !== undefined)).toBe(true)

        // The publisher is still tied to the plugin's activation scope.
        await Effect.runPromise(Scope.close(scope, Exit.void))
        const published = harness.events.length
        await Bun.sleep(60)
        expect(harness.events).toHaveLength(published)
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {})
      }
    }))
})
