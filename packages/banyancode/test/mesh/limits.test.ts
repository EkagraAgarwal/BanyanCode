import { describe, expect, test } from "bun:test"
import {
  applySubagentPermissionDecision,
  checkNestedSpawn,
  MAX_NESTED_EXPLORE_LIFETIME_PER_CODER,
  MAX_SUBAGENTS_LIMIT,
  NESTED_LIFETIME_WINDOW_MS,
  readLimits,
  resolveWaveSize,
  subagentLimitDecision,
  subagentToolGuard,
  validateMaxSubagents,
} from "../../src/mesh/limits.js"
import { parseSwarmCommand, SWARM_COMMAND } from "../../src/mesh/commands.js"
import { emptyTokens, type MeshSessionSnapshot } from "../../src/mesh/types.js"

const snapshot = (sessionID: string, overrides: Partial<MeshSessionSnapshot> = {}): MeshSessionSnapshot => ({
  sessionID,
  agent: "coder",
  cost: 0,
  tokens: emptyTokens(),
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
})

const tree = (runningSubagents: number) => {
  const sessions = new Map<string, MeshSessionSnapshot>()
  sessions.set("root", snapshot("root", { agent: "orchestrator" }))
  for (let index = 0; index < runningSubagents; index += 1) {
    sessions.set(
      `child-${index}`,
      snapshot(`child-${index}`, {
        parentID: "root",
        agent: "coder",
        busyAt: 3_000,
        idleAt: 2_000,
      }),
    )
  }
  return sessions
}

describe("max subagents limit", () => {
  test("allows below the cap and denies at the cap with a teaching message", () => {
    const allowed = subagentLimitDecision({ sessions: tree(1), sessionID: "root", maxSubagents: 2 })
    expect(allowed).toMatchObject({ deny: false, running: 1, max: 2 })

    const denied = subagentLimitDecision({ sessions: tree(2), sessionID: "root", maxSubagents: 2 })
    expect(denied.deny).toBe(true)
    expect(denied.running).toBe(2)
    expect(denied.message).toContain("Max 2 subagents reached")
  })

  test("permission.evaluate hook denies the real subagent assertion shape", () => {
    // Exactly the payload v2's subagent tool passes to permission.assert.
    const event: {
      sessionID: string
      agent: string
      action: string
      resources: string[]
      source: { type: "tool"; messageID: string; id: string }
      effect: "allow" | "deny" | "ask"
      message?: string
    } = {
      sessionID: "root",
      agent: "orchestrator",
      action: "subagent",
      resources: ["coder"],
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
      effect: "allow",
    }
    applySubagentPermissionDecision(event, { sessions: tree(2), maxSubagents: 2 })
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("Max 2 subagents reached")
  })

  test("permission.evaluate hook leaves unrelated actions and existing denies alone", () => {
    const unrelated: { sessionID: string; action: string; resources: string[]; effect: "allow" | "deny" | "ask"; message?: string } = {
      sessionID: "root",
      action: "bash",
      resources: ["*"],
      effect: "allow",
    }
    applySubagentPermissionDecision(unrelated, { sessions: tree(9), maxSubagents: 1 })
    expect(unrelated.effect).toBe("allow")

    const denied: typeof unrelated = {
      sessionID: "root",
      action: "subagent",
      resources: ["coder"],
      effect: "deny",
      message: "rule",
    }
    applySubagentPermissionDecision(denied, { sessions: tree(9), maxSubagents: 1 })
    expect(denied.message).toBe("rule")
  })

  test("validates 1..20 and clamps config values", () => {
    expect(validateMaxSubagents(1)).toEqual({ ok: true, value: 1 })
    expect(validateMaxSubagents(MAX_SUBAGENTS_LIMIT).ok).toBe(true)
    expect(validateMaxSubagents(0).ok).toBe(false)
    expect(validateMaxSubagents(21).ok).toBe(false)
    expect(validateMaxSubagents(1.5).ok).toBe(false)
    expect(readLimits({ banyancode_max_subagents: 99 }).maxSubagents).toBe(MAX_SUBAGENTS_LIMIT)
    expect(readLimits({}).maxSubagents).toBe(5)
    expect(readLimits({}, { maxSubagents: 3 }).maxSubagents).toBe(3)
  })
})

describe("subagent tool gate", () => {
  test("blocks background spawns when banyancode_background_subagents=false", () => {
    const decision = subagentToolGuard({
      tool: "subagent",
      callerSessionID: "root",
      callerAgent: "orchestrator",
      targetAgent: "coder",
      background: true,
      backgroundEnabled: false,
      sessions: tree(0),
      maxSubagents: 5,
      now: 1_000,
    })
    expect(decision.deny).toBe(true)
    expect(decision.message).toContain("banyancode_background_subagents=false")
  })

  test("applies the max limit through execute.before with realistic tool input", () => {
    const decision = subagentToolGuard({
      tool: "subagent",
      callerSessionID: "root",
      callerAgent: "orchestrator",
      targetAgent: "coder",
      background: true,
      backgroundEnabled: true,
      sessions: tree(2),
      maxSubagents: 2,
      now: 1_000,
    })
    expect(decision.deny).toBe(true)
    expect(decision.message).toContain("Max 2 subagents reached")
  })

  test("follow-ups to an existing subagent bypass spawn limits", () => {
    const decision = subagentToolGuard({
      tool: "subagent",
      callerSessionID: "root",
      callerAgent: "orchestrator",
      targetAgent: "coder",
      followUpSessionID: "child-0",
      background: true,
      backgroundEnabled: false,
      sessions: tree(2),
      maxSubagents: 2,
      now: 1_000,
    })
    expect(decision.deny).toBe(false)
  })

  test("nested explore budget blocks a second concurrent explore and the 6th lifetime spawn", () => {
    const sessions = tree(0)
    sessions.set("coder-1", snapshot("coder-1", { parentID: "root", agent: "coder" }))
    const first = checkNestedSpawn({ sessions, coderSessionID: "coder-1", now: 1_000 })
    expect(first.ok).toBe(true)

    sessions.set(
      "explore-1",
      snapshot("explore-1", { parentID: "coder-1", agent: "explore", busyAt: 3_000, idleAt: 2_000 }),
    )
    const concurrent = checkNestedSpawn({
      sessions,
      coderSessionID: "coder-1",
      entry: first.ok ? first.entry : undefined,
      now: 1_000,
    })
    expect(concurrent).toMatchObject({ ok: false, error: "concurrent" })

    const lifetime = checkNestedSpawn({
      sessions: tree(0),
      coderSessionID: "coder-1",
      entry: { lifetimeCount: MAX_NESTED_EXPLORE_LIFETIME_PER_CODER, windowStart: 1_000 },
      now: 1_000,
    })
    expect(lifetime).toMatchObject({ ok: false, error: "lifetime" })

    // An expired window resets the lifetime counter.
    const reset = checkNestedSpawn({
      sessions: tree(0),
      coderSessionID: "coder-1",
      entry: { lifetimeCount: MAX_NESTED_EXPLORE_LIFETIME_PER_CODER, windowStart: 1 },
      now: 1 + NESTED_LIFETIME_WINDOW_MS + 1,
    })
    expect(reset.ok).toBe(true)
  })
})

describe("/swarm parsing", () => {
  test("no arguments toggles and the command name stays v1-compatible", () => {
    expect(SWARM_COMMAND).toBe("swarm")
    expect(parseSwarmCommand("", { available: 3 })).toEqual({ mode: "toggle" })
  })

  test("parses a task, count, and agent; clamps to free slots", () => {
    expect(parseSwarmCommand("fix the mesh --agents 2 --agent scout", { available: 3 })).toEqual({
      mode: "spawn",
      count: 2,
      agent: "scout",
      task: "fix the mesh",
      clamped: false,
    })
    const clamped = parseSwarmCommand("do work --agents 9", { available: 2 })
    expect(clamped).toMatchObject({ mode: "spawn", count: 2, clamped: true })
  })

  test("rejects missing tasks and exhausted slots", () => {
    expect(parseSwarmCommand("--agents 2", { available: 3 })).toMatchObject({ mode: "error" })
    expect(parseSwarmCommand("do work", { available: 0 })).toMatchObject({ mode: "error" })
    expect(parseSwarmCommand("do work --agents nope", { available: 3 })).toMatchObject({ mode: "error" })
  })

  test("wave sizing never exceeds the remaining budget", () => {
    expect(resolveWaveSize(undefined, 1, 5)).toBe(4)
    expect(resolveWaveSize(9, 1, 5)).toBe(4)
    expect(resolveWaveSize(2, 4, 5)).toBe(1)
  })
})
