import { expect, test } from "bun:test"
import type { Context, KeymapCommand, SlotClaim } from "@opencode/plugin/tui/context"
import BanyanTui from "../src/tui"
import { context } from "./harness"

interface Call {
  readonly target: string
  readonly input: unknown
  readonly location: unknown
}

function recordingContext() {
  const calls: Call[] = []
  const synced: string[] = []
  const commands: KeymapCommand[] = []
  const base = context()
  const rpc = (definition: { readonly id: string }) =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === "events") {
            return new Proxy({}, { get: () => () => () => {} })
          }
          return async (input?: unknown, options?: { readonly location?: unknown }) => {
            calls.push({ target: `${definition.id}.${String(property)}`, input, location: options?.location })
            if (property === "limits.set") {
              return {
                ok: true,
                limits: {
                  maxSubagents: 5,
                  backgroundSubagents: true,
                  swarmMode: true,
                  maxSubagentsLimit: 20,
                  maxSubagentsDefault: 5,
                },
              }
            }
            if (property === "yolo.set") return { enabled: true, env: false, config: true }
            if (property === "yolo.get") return { enabled: true, env: false, config: true }
            if (property === "config.get") return { config: {} }
            if (property === "lsp.status") return { enabled: true, servers: [], idleTimeoutMs: 1 }
            if (property === "limits.get") {
              return {
                maxSubagents: 5,
                backgroundSubagents: true,
                swarmMode: false,
                maxSubagentsLimit: 20,
                maxSubagentsDefault: 5,
              }
            }
            return {}
          }
        },
      },
    )
  const value = {
    ...base,
    location: { directory: "D:/workspace" },
    client: { rpc } as unknown as Context["client"],
    data: {
      ...base.data,
      location: {
        ...base.data.location,
        model: {
          ...base.data.location.model,
          sync: async (location?: { readonly directory: string }) => {
            synced.push(location?.directory ?? "default")
          },
        },
      },
    },
    ui: {
      ...base.ui,
      slot: (_claim: SlotClaim) => () => {},
      router: { ...base.ui.router, register: () => () => {} },
      // Commands are executed directly in this test.
      toast: { show: () => {} },
    },
    keymap: {
      ...base.keymap,
      layer: (factory: () => { readonly commands?: readonly KeymapCommand[] }) => {
        commands.push(...(factory().commands ?? []))
      },
    },
  } as unknown as Context
  return { context: value, commands, calls, synced }
}

test("palette registers the v1 BanyanCode ids and slash intercepts", () => {
  const recorded = recordingContext()
  const cleanup = BanyanTui.setup(recorded.context)
  if (typeof cleanup === "function") void cleanup()
  const ids = recorded.commands.map((command) => command.id)
  for (const id of [
    "agent.model",
    "models.refresh",
    "yolo.toggle",
    "swarm.toggle",
    "subagents.max_subagents",
    "thinking.set",
  ]) {
    expect(ids).toContain(id)
  }
  expect(recorded.commands.find((command) => command.id === "agent.model")?.slash).toEqual({ name: "agent-model" })
  expect(recorded.commands.find((command) => command.id === "thinking.set")?.slash).toEqual({
    name: "thinking",
    aliases: ["variant", "reasoning"],
    arguments: true,
  })
})

test("models.refresh re-syncs only the current location's model catalog", async () => {
  const recorded = recordingContext()
  const cleanup = BanyanTui.setup(recorded.context)
  try {
    const command = recorded.commands.find((item) => item.id === "models.refresh")
    await command?.run()
    expect(recorded.synced).toEqual(["D:/workspace"])
    expect(recorded.calls.filter((call) => call.location !== undefined)).toEqual([])
  } finally {
    if (typeof cleanup === "function") await cleanup()
  }
})

test("yolo.toggle and swarm.toggle call the live RPCs", async () => {
  const recorded = recordingContext()
  const cleanup = BanyanTui.setup(recorded.context)
  try {
    await recorded.commands.find((item) => item.id === "yolo.toggle")?.run()
    expect(recorded.calls.some((call) => call.target === "banyancode.system.yolo.set")).toBe(true)
    await recorded.commands.find((item) => item.id === "swarm.toggle")?.run()
    expect(recorded.calls.some((call) => call.target === "banyancode.mesh.limits.set")).toBe(true)
  } finally {
    if (typeof cleanup === "function") await cleanup()
  }
})
