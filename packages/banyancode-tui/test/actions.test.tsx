/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { MeshLimits } from "../src/data/pending-rpc"
import {
  applyVariantCommand,
  openAgentControl,
  openAgentModel,
  openMaxSubagents,
  steerSubagent,
  killSubagent,
} from "../src/components/dialogs/actions"
import { context, meshLive, meshNode, systemLive } from "./harness"

interface Toast {
  readonly message: string
  readonly variant?: string
}

function fakeContext(input: {
  readonly base?: ReturnType<typeof context>
  readonly prompts?: string[]
  readonly selects?: unknown[]
  readonly confirms?: boolean[]
  readonly variants?: { list: string[]; current?: string }
}) {
  const toasts: Toast[] = []
  const promptValues = [...(input.prompts ?? [])]
  const selectValues = [...(input.selects ?? [])]
  const confirmValues = [...(input.confirms ?? [])]
  const setVariant: Array<string | undefined> = []
  const base = input.base ?? context()
  const value = {
    ...base,
    ui: {
      ...base.ui,
      toast: { show: (options: Toast) => toasts.push(options) },
      dialog: {
        ...base.ui.dialog,
        prompt: async () => promptValues.shift(),
        select: async () => selectValues.shift(),
        confirm: async () => confirmValues.shift(),
        alert: async () => {},
        clear: () => {},
      },
      model: {
        current: () => (input.variants?.current === undefined ? undefined : { providerID: "p", modelID: "m", variant: input.variants.current }),
        variant: {
          list: () => input.variants?.list ?? [],
          set: (variant: string | undefined) => {
            setVariant.push(variant)
            return true
          },
        },
      },
    },
  } as unknown as Context
  return { context: value, toasts, setVariant }
}

function limits(maxSubagents: number): MeshLimits {
  return {
    maxSubagents,
    backgroundSubagents: true,
    swarmMode: false,
    maxSubagentsLimit: 20,
    maxSubagentsDefault: 5,
  }
}

test("max-subagents dialog saves a 1-20 integer through mesh limits.set", async () => {
  const fake = fakeContext({ prompts: ["12"] })
  const captured: Array<{ readonly maxSubagents?: number }> = []
  const live = {
    mesh: {
      ...meshLive({ maxSubagents: 5 }),
      limits: () => limits(5),
      setLimits: async (input: { readonly maxSubagents?: number }) => {
        captured.push(input)
        return { ok: true as const, value: limits(input.maxSubagents ?? 5) }
      },
    },
  }
  await openMaxSubagents(fake.context, live as unknown as Parameters<typeof openMaxSubagents>[1])
  expect(captured).toEqual([{ maxSubagents: 12 }])
  expect(fake.toasts.at(-1)?.message).toContain("Max subagents set to 12")
})

test("max-subagents dialog rejects values outside 1-20 without writing", async () => {
  const fake = fakeContext({ prompts: ["21"] })
  let calls = 0
  const live = {
    mesh: {
      ...meshLive({ maxSubagents: 5 }),
      limits: () => limits(5),
      setLimits: async () => {
        calls += 1
        return { ok: true as const, value: limits(5) }
      },
    },
  }
  await openMaxSubagents(fake.context, live as unknown as Parameters<typeof openMaxSubagents>[1])
  expect(calls).toBe(0)
  expect(fake.toasts.at(-1)?.variant).toBe("error")
})

test("agent model picker writes the chosen model through agentOverride", async () => {
  const base = context({
    agents: [
      { name: "orchestrator", mode: "primary", hidden: false } as never,
      { name: "coder", mode: "subagent", hidden: false } as never,
    ],
    models: [
      { providerID: "provider", modelID: "model-a", name: "A" } as never,
      { providerID: "provider", modelID: "model-b", name: "B" } as never,
    ],
  })
  const fake = fakeContext({ base, selects: ["coder", "provider/model-b"] })
  const written: Array<{ name: string; model?: { providerID: string; modelID: string } }> = []
  const live = {
    core: { config: () => undefined, status: () => undefined, availability: () => "available" as const, refresh: async () => {} },
    system: {
      ...systemLive(),
      agentOverride: async (input: { name: string; model?: { providerID: string; modelID: string } }) => {
        written.push(input)
        return { ok: true as const, value: {} as never }
      },
    },
  }
  await openAgentModel(fake.context, live as unknown as Parameters<typeof openAgentModel>[1])
  expect(written).toEqual([{ name: "coder", model: { providerID: "provider", modelID: "model-b" } }])
  expect(fake.toasts.at(-1)?.message).toContain("Saved coder model")
})

test("agent tree dialog steers the chosen subagent", async () => {
  const child = meshNode({ sessionID: "ses_child", agent: "coder", state: "running" })
  const tree = meshNode({ sessionID: "ses_root", state: "running", children: [child] })
  const base = context({
    sessions: [
      { id: "ses_root", title: "root" } as never,
      { id: "ses_child", parentID: "ses_root", title: "worker", agent: "coder" } as never,
    ],
  })
  const fake = fakeContext({ base, selects: [child, "steer"], prompts: ["go faster"] })
  const steered: Array<{ parentSessionID: string; targetAgent: string; targetSessionID?: string; instruction: string }> =
    []
  const live = {
    mesh: {
      ...meshLive({ root: tree, maxSubagents: 5 }),
      root: () => tree,
      ensure: async () => {},
      refreshLimits: async () => {},
      limits: () => limits(5),
      steer: async (input: {
        parentSessionID: string
        targetAgent: string
        targetSessionID?: string
        instruction: string
      }) => {
        steered.push(input)
        return { ok: true as const, value: { delivered: 1 } }
      },
      kill: async () => ({ ok: true as const, value: { killed: 1 } }),
    },
  }
  await openAgentControl(fake.context, live as unknown as Parameters<typeof openAgentControl>[1])
  expect(steered).toEqual([
    { parentSessionID: "ses_root", targetAgent: "coder", targetSessionID: "ses_child", instruction: "go faster" },
  ])
  expect(fake.toasts.at(-1)?.message).toContain("Steer sent")
})

test("agent tree kill targets the selected session, not every child of the agent", async () => {
  const base = context({
    sessions: [
      { id: "ses_root", title: "root" } as never,
      { id: "ses_a", parentID: "ses_root", title: "first explore", agent: "explore" } as never,
      { id: "ses_b", parentID: "ses_root", title: "second explore", agent: "explore" } as never,
    ],
  })
  const target = { sessionID: "ses_a", agent: "explore", title: "first explore", state: "running" as const, killed: false }
  const fake = fakeContext({ base, selects: [target, "kill"], confirms: [true] })
  const killed: Array<{ parentSessionID: string; targetAgent?: string; targetSessionID?: string }> = []
  const live = {
    mesh: {
      ...meshLive(),
      root: () => undefined,
      ensure: async () => {},
      refreshLimits: async () => {},
      limits: () => limits(5),
      kill: async (input: { parentSessionID: string; targetAgent?: string; targetSessionID?: string }) => {
        killed.push(input)
        return { ok: true as const, value: { killed: 1 } }
      },
    },
  }
  await openAgentControl(fake.context, live as unknown as Parameters<typeof openAgentControl>[1])
  expect(killed).toHaveLength(1)
  expect(killed[0]).toMatchObject({ parentSessionID: "ses_root", targetSessionID: "ses_a" })
  expect(killed[0]?.targetAgent).toBeUndefined()
})

test("agent tree refuses to kill a child that is already finished", async () => {
  const base = context({
    sessions: [
      { id: "ses_root", title: "root" } as never,
      { id: "ses_a", parentID: "ses_root", title: "first explore", agent: "explore" } as never,
    ],
  })
  const target = { sessionID: "ses_a", agent: "explore", title: "first explore", state: "interrupted" as const, killed: true }
  const fake = fakeContext({ base, selects: [target] })
  let calls = 0
  const live = {
    mesh: {
      ...meshLive({ killed: ["ses_a"] }),
      root: () => undefined,
      ensure: async () => {},
      refreshLimits: async () => {},
      limits: () => limits(5),
      kill: async () => {
        calls += 1
        return { ok: true as const, value: { killed: 1 } }
      },
    },
  }
  await openAgentControl(fake.context, live as unknown as Parameters<typeof openAgentControl>[1])
  expect(calls).toBe(0)
  expect(fake.toasts.at(-1)?.message).toContain("already finished")
})

test("steering a done or failed child sends the instruction to its own session", async () => {
  const recorded: Array<{ parentSessionID: string; targetAgent: string; targetSessionID?: string; instruction: string }> =
    []
  const mesh = {
    ...meshLive(),
    steer: async (input: {
      parentSessionID: string
      targetAgent: string
      targetSessionID?: string
      instruction: string
    }) => {
      recorded.push(input)
      return { ok: true as const, value: { delivered: 1 } }
    },
  } as unknown as Parameters<typeof steerSubagent>[1]

  for (const target of [
    // `idle` is a finished child in mesh terms; `done` is the pane's word for it.
    { sessionID: "ses_done", agent: "coder", state: "idle" as const, killed: false },
    { sessionID: "ses_failed", agent: "coder", state: "failed" as const, killed: false },
  ]) {
    const fake = fakeContext({ prompts: ["try again"] })
    await steerSubagent(fake.context, mesh, "ses_root", target)
    expect(fake.toasts.at(-1)?.message).toContain(`Steer sent to ${target.sessionID}`)
  }
  expect(recorded).toEqual([
    { parentSessionID: "ses_root", targetAgent: "coder", targetSessionID: "ses_done", instruction: "try again" },
    { parentSessionID: "ses_root", targetAgent: "coder", targetSessionID: "ses_failed", instruction: "try again" },
  ])
})

test("steering a killed child is refused without prompting or calling the RPC", async () => {
  const fake = fakeContext({ prompts: ["wake up"] })
  let calls = 0
  const mesh = {
    ...meshLive(),
    steer: async () => {
      calls += 1
      return { ok: true as const, value: { delivered: 1 } }
    },
  } as unknown as Parameters<typeof steerSubagent>[1]
  await steerSubagent(fake.context, mesh, "ses_root", {
    sessionID: "ses_gone",
    agent: "coder",
    state: "failed",
    killed: true,
  })
  expect(calls).toBe(0)
  expect(fake.toasts.at(-1)?.message).toContain("already finished")
})

test("steer and kill report a missing mesh RPC instead of pretending success", async () => {
  const node = meshNode({ sessionID: "ses_child", agent: "coder", state: "running" })
  const fake = fakeContext({ prompts: ["instruction"], confirms: [true] })
  const live = {
    mesh: {
      ...meshLive(),
      steer: async () => ({ ok: false as const, unavailable: true, message: "rpc.method_not_found" }),
      kill: async () => ({ ok: false as const, unavailable: true, message: "rpc.method_not_found" }),
    },
  }
  const target = { ...node, killed: false }
  await steerSubagent(fake.context, live.mesh as unknown as Parameters<typeof steerSubagent>[1], "ses_root", target)
  expect(fake.toasts.at(-1)?.variant).toBe("warning")
  await killSubagent(fake.context, live.mesh as unknown as Parameters<typeof killSubagent>[1], "ses_root", target)
  expect(fake.toasts.at(-1)?.variant).toBe("warning")
})

test("thinking/variant/reasoning intercept reads and sets the model variant", () => {
  const fake = fakeContext({ variants: { list: ["low", "high"], current: "high" } })
  applyVariantCommand(fake.context, "")
  expect(fake.toasts.at(-1)?.message).toContain("Current variant: high")
  applyVariantCommand(fake.context, "off")
  expect(fake.setVariant.at(-1)).toBeUndefined()
  applyVariantCommand(fake.context, "on")
  expect(fake.setVariant.at(-1)).toBe("high")
  applyVariantCommand(fake.context, "low")
  expect(fake.setVariant.at(-1)).toBe("low")
  applyVariantCommand(fake.context, "ultra")
  expect(fake.toasts.at(-1)?.variant).toBe("warning")
})
