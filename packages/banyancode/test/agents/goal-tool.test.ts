import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { GOAL_TOOL, makeGoalTool } from "../../src/agents/goal-tool.js"

const goal = {
  id: "goal-1",
  objective: "ship the release",
  status: "active" as const,
  rounds: 1,
  maxRounds: 50,
  boot: "boot-1",
  updatedAt: 1,
}

const harness = (current: typeof goal | null = goal) => {
  const commands: { name: string; text: string }[] = []
  const ctx = {
    permission: { assert: () => Effect.void },
    rpc: () => ({ get: () => Effect.succeed(current) }),
    session: {
      command: (input: { name: string; text: string }) =>
        Effect.sync(() => {
          commands.push({ name: input.name, text: input.text })
          return undefined
        }),
    },
  } as unknown as Context
  const tool = makeGoalTool(ctx)
  const call = (input: { action: string; condition?: string }) =>
    Effect.runPromise(
      tool.execute(input as never, {
        sessionID: "ses_tool" as never,
        agent: "orchestrator" as never,
        messageID: "msg_1" as never,
        id: "call_1" as never,
        progress: () => Effect.void,
      }) as Effect.Effect<{ output: { ok: boolean; goal?: unknown; message?: string }; content: string }>,
    )
  return { tool, commands, call }
}

describe("goal tool (v1 LLM tool bridged to v2 goal mode)", () => {
  test("is named `goal` and offers the v2-supported actions", () => {
    const h = harness()
    expect(h.tool.name).toBe(GOAL_TOOL)
    expect(h.tool.description).toContain("set")
    expect(h.tool.description).toContain("cancel")
  })

  test("set drives the built-in /goal command and returns the new state", async () => {
    const h = harness()
    const result = await h.call({ action: "set", condition: "ship the release" })
    expect(h.commands).toEqual([{ name: "goal", text: "ship the release" }])
    expect(result.output.ok).toBe(true)
    expect(result.content).toContain("Goal active: ship the release")
  })

  test("set requires a condition", async () => {
    const h = harness()
    const result = await h.call({ action: "set", condition: "   " })
    expect(result.output.ok).toBe(false)
    expect(h.commands).toHaveLength(0)
  })

  test("pause, resume and cancel map onto /goal controls", async () => {
    const h = harness()
    await h.call({ action: "pause" })
    await h.call({ action: "resume" })
    await h.call({ action: "cancel" })
    expect(h.commands).toEqual([
      { name: "goal", text: "pause" },
      { name: "goal", text: "resume" },
      { name: "goal", text: "clear" },
    ])
  })

  test("status and list read the goal plugin RPC without running a command", async () => {
    const h = harness()
    const status = await h.call({ action: "status" })
    const list = await h.call({ action: "list" })
    expect(status.content).toContain("Goal active")
    expect(JSON.parse(list.content)).toEqual([goal])
    expect(h.commands).toHaveLength(0)
  })

  test("no goal reports the v1 null shape", async () => {
    const h = harness(null)
    const status = await h.call({ action: "status" })
    expect(status.output.goal).toBeNull()
    expect(status.content).toBe("No goal is set.")
  })
})
