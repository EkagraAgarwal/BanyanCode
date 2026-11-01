import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Goal } from "@opencode/schema/goal"
import { Effect } from "effect"
import { GOAL_TOOL, makeGoalTool, settingsFromConfig } from "../../src/agents/goal-tool.js"

const goal: Goal.State = {
  id: "goal-1",
  objective: "ship the release",
  status: "active",
  rounds: 1,
  maxRounds: 50,
  boot: "boot-1",
  updatedAt: 1,
}

type ReviewInput = { sessionID: string; verdict: Goal.Verdict; reason: string }
type SettleInput = { sessionID: string; status: "complete" | "paused"; reason: string }

const harness = (initial: Goal.State | null = goal) => {
  const commands: { name: string; text: string }[] = []
  const reviews: ReviewInput[] = []
  const settles: SettleInput[] = []
  let current = initial
  const rpc = {
    // The goal plugin's `review` handler: one verdict is one round, and the round budget pauses the goal.
    review: (input: ReviewInput) =>
      Effect.sync(() => {
        reviews.push(input)
        if (current === null || current.status !== "active") return current
        const rounds = current.rounds + 1
        const capped = rounds >= current.maxRounds && input.verdict !== "pass"
        current = capped
          ? { ...current, status: "paused", rounds, reason: "max iterations reached" }
          : { ...current, rounds, reason: input.reason }
        return current
      }),
    settle: (input: SettleInput) =>
      Effect.sync(() => {
        settles.push(input)
        if (current === null || current.status !== "active") return current
        current = { ...current, status: input.status, reason: input.reason }
        return current
      }),
    get: () => Effect.succeed(current),
    configure: () => Effect.die("unused rpc.configure"),
  }
  const ctx = {
    permission: { assert: () => Effect.void },
    rpc: () => rpc,
    session: {
      command: (input: { name: string; text: string }) =>
        Effect.sync(() => {
          commands.push({ name: input.name, text: input.text })
          return undefined
        }),
    },
  } as unknown as Context
  const tool = makeGoalTool(ctx)
  const call = (input: Record<string, unknown>) =>
    Effect.runPromise(
      tool.execute(input as never, {
        sessionID: "ses_tool" as never,
        agent: "orchestrator" as never,
        messageID: "msg_1" as never,
        id: "call_1" as never,
        progress: () => Effect.void,
      }) as Effect.Effect<{
        output: { ok: boolean; goal?: unknown; message?: string; loopEnded?: boolean }
        content: string
      }>,
    )
  return { tool, commands, reviews, settles, call, current: () => current }
}

describe("goal tool (v1 LLM tool bridged to v2 goal mode)", () => {
  test("is named `goal` and offers the v1 actions plus the v2 controls", () => {
    const h = harness()
    expect(h.tool.name).toBe(GOAL_TOOL)
    for (const action of ["set", "status", "list", "record_review", "complete", "block", "cancel"]) {
      expect(h.tool.description).toContain(action)
    }
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

  test("record_review records the verdict as a round", async () => {
    const h = harness()
    const result = await h.call({ action: "record_review", reviewID: "rev-1", verdict: "fail", reason: "the parser test fails" })
    expect(h.reviews).toEqual([{ sessionID: "ses_tool", verdict: "fail", reason: "the parser test fails" }])
    expect(result.output.ok).toBe(true)
    expect(result.output.loopEnded).toBeUndefined()
    expect(h.current()).toMatchObject({ status: "active", rounds: 2, reason: "the parser test fails" })
  })

  test("record_review reports the loop ending at the round budget", async () => {
    const h = harness({ ...goal, rounds: 0, maxRounds: 1 })
    const result = await h.call({ action: "record_review", reviewID: "rev-1", verdict: "fail", reason: "the parser test fails" })
    expect(result.output.ok).toBe(true)
    expect(result.output.loopEnded).toBe(true)
    expect(result.output.message).toBe("max iterations reached")
    expect(h.current()).toMatchObject({ status: "paused", reason: "max iterations reached" })
  })

  test("record_review requires a verdict", async () => {
    const h = harness()
    const result = await h.call({ action: "record_review", reviewID: "rev-1" })
    expect(result.output.ok).toBe(false)
    expect(h.reviews).toHaveLength(0)
  })

  test("complete settles the goal achieved", async () => {
    const h = harness()
    const result = await h.call({ action: "complete", reason: "All 12 tests pass." })
    expect(h.settles).toEqual([{ sessionID: "ses_tool", status: "complete", reason: "All 12 tests pass." }])
    expect(result.output.ok).toBe(true)
    expect(h.current()).toMatchObject({ status: "complete", reason: "All 12 tests pass." })
  })

  test("block requires a reason and pauses the goal with it", async () => {
    const h = harness()
    const missing = await h.call({ action: "block" })
    expect(missing.output.ok).toBe(false)
    expect(h.settles).toHaveLength(0)

    const blocked = await h.call({ action: "block", reason: "Waiting on the user." })
    // v2 has no blocked status: the loop stops as paused and the reason is shown.
    expect(h.settles).toEqual([{ sessionID: "ses_tool", status: "paused", reason: "Waiting on the user." }])
    expect(blocked.output.ok).toBe(true)
    expect(h.current()).toMatchObject({ status: "paused", reason: "Waiting on the user." })
  })

  test("a v1 goalID must match the session's goal", async () => {
    const h = harness()
    const other = await h.call({ action: "record_review", goalID: "goal-2", verdict: "fail", reason: "x" })
    expect(other.output.ok).toBe(false)
    expect(other.output.message).toContain("unknown goal")
    expect(h.reviews).toHaveLength(0)

    const same = await h.call({ action: "record_review", goalID: "goal-1", verdict: "pass", reason: "looks good" })
    expect(same.output.ok).toBe(true)
    expect(h.reviews).toHaveLength(1)
  })
})

describe("goal settings from banyancode.json", () => {
  test("maps the four goal keys onto the goal plugin settings", () => {
    expect(
      settingsFromConfig({
        banyancode_max_goal_iterations: 2,
        banyancode_goal_max_time_ms: 60_000,
        banyancode_goal_auto_retry_on_block: true,
        banyancode_goal_evaluator_model: "cheap/fast",
      }),
    ).toEqual({ maxRounds: 2, maxTimeMs: 60_000, autoRetryOnBlock: true, evaluatorModel: "cheap/fast" })
  })

  test("forwards only the keys the user set, so unset keys keep the stock behavior", () => {
    expect(settingsFromConfig({})).toEqual({})
    expect(settingsFromConfig({ banyancode_max_goal_iterations: 0 })).toEqual({ maxRounds: 0 })
    // `false` is meaningful: it turns auto-retry off rather than leaving it unset.
    expect(settingsFromConfig({ banyancode_goal_auto_retry_on_block: false })).toEqual({ autoRetryOnBlock: false })
  })
})
