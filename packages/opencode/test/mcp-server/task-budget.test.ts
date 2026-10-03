// Per-task USD cap tests (Milestone C6, gap-plan open question 5 → yes).
//
// Cost updates arrive as session.cost events through the REAL engine event
// source path (harness.emit → enqueue → single sequential drain → apply),
// mirroring the Jev per-session budget accounting pattern: each event
// carries a cumulative per-session USD total and the task spend is the sum
// of the per-session high-water marks (root + children).

import { describe, expect, test } from "bun:test"
import { TaskEngine } from "../../src/mcp-server/task-engine"
import { DEFAULT_TASK_BUDGET_USD } from "../../src/mcp-server/task-engine"
import type {
  EngineEvent,
  EngineEventSource,
  EngineSessionClient,
  EngineSessionMessage,
  PendingQuestion,
} from "../../src/mcp-server/task-engine"

class Harness implements EngineSessionClient {
  sessions = new Map<string, { prompts: string[]; busy: boolean; assistant: string[]; metadata: Record<string, string> }>()
  children = new Map<string, string[]>()
  aborts: string[] = []
  next = 1
  listeners: Array<(event: EngineEvent) => void> = []

  readonly events: EngineEventSource = {
    subscribe: (handler) => {
      this.listeners.push(handler)
      return () => {
        this.listeners = this.listeners.filter((l) => l !== handler)
      }
    },
  }

  emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  store = {
    findSession: async (input: { sessionID: string }) => {
      const session = this.sessions.get(input.sessionID)
      return session ? { metadata: session.metadata } : undefined
    },
    listMcpSessions: async () => {
      const out: Array<{ sessionID: string; metadata: Record<string, string> }> = []
      for (const [sessionID, session] of this.sessions) {
        if (session.metadata["origin"] === "mcp") out.push({ sessionID, metadata: session.metadata })
      }
      return out
    },
  }

  async createSession(input: { title?: string; metadata: Record<string, string> }) {
    void input.title
    const id = `ses_test_${this.next++}`
    this.sessions.set(id, { prompts: [], busy: false, assistant: [], metadata: { ...input.metadata } })
    return { id }
  }

  async promptAsync(input: { sessionID: string; prompt: string }) {
    const session = this.sessions.get(input.sessionID)
    if (!session) throw new Error("unknown session")
    session.prompts.push(input.prompt)
    session.busy = true
  }

  async abort(input: { sessionID: string }) {
    this.aborts.push(input.sessionID)
    this.sessions.get(input.sessionID)!.busy = false
  }

  async sessionStatus(input: { sessionID: string }) {
    void input
    return this.sessions.get(input.sessionID)?.busy ? ("busy" as const) : ("idle" as const)
  }

  async messages(input: { sessionID: string }): Promise<EngineSessionMessage[]> {
    void input
    const session = this.sessions.get(input.sessionID)
    const out: EngineSessionMessage[] = []
    for (const prompt of session?.prompts ?? []) out.push({ role: "user", text: prompt })
    for (const text of session?.assistant ?? []) out.push({ role: "assistant", text })
    return out
  }

  async pending(_input: { sessionID: string }): Promise<PendingQuestion[]> {
    return []
  }

  async replyPermission(_input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }) {}
  async rejectQuestion(_input: { sessionID: string; requestID: string }) {}
  async replyQuestion(_input: { sessionID: string; requestID: string; message: string }) {
    this.sessions.get(_input.sessionID)!.busy = true
  }

  async writeMetadata(input: { sessionID: string; metadata: Record<string, string> }) {
    Object.assign(this.sessions.get(input.sessionID)!.metadata, input.metadata)
  }

  async listChildren(input: { sessionID: string }): Promise<string[]> {
    void input
    return this.children.get(input.sessionID) ?? []
  }
}

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("per-task USD cap", () => {
  test("spend over a tiny cap aborts the task with failed/BUDGET and frees the slot", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 1 })
    const first = await engine.start({ prompt: "spendy", budgetUsd: 0.01 })
    const second = await engine.start({ prompt: "queued" })
    expect(second.status).toBe("queued")

    harness.emit({ type: "session.cost", sessionID: first.sessionID, cost: 0.005 })
    await flush()
    expect(engine.get(first.handle).status).toBe("running")
    expect(engine.get(first.handle).cost).toBeCloseTo(0.005)

    // Cumulative total crosses the cap: abort + failed/BUDGET.
    harness.emit({ type: "session.cost", sessionID: first.sessionID, cost: 0.02 })
    await flush()
    const failed = engine.get(first.handle)
    expect(failed.status).toBe("failed")
    expect(failed.errorCode).toBe("BUDGET")
    expect(failed.error).toContain("0.01")
    expect(harness.aborts).toEqual([first.sessionID])
    // The freed slot launches the queued task.
    expect(engine.get(second.handle).status).toBe("running")
    expect(harness.sessions.get(second.sessionID)!.prompts).toEqual(["queued"])
    engine.close()
  })

  test("child-session spend counts toward the same cap", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 4 })
    const started = await engine.start({ prompt: "with subagent", budgetUsd: 0.05 })
    harness.children.set(started.sessionID, ["ses_test_child"])
    harness.emit({ type: "session.cost", sessionID: started.sessionID, cost: 0.02 })
    await flush()
    expect(engine.get(started.handle).cost).toBeCloseTo(0.02)
    // Child cost arrives under its own session ID and is attributed to the
    // root task through the session tree.
    harness.emit({ type: "session.cost", sessionID: "ses_test_child", cost: 0.04 })
    await flush()
    const failed = engine.get(started.handle)
    expect(failed.cost).toBeCloseTo(0.06)
    expect(failed.status).toBe("failed")
    expect(failed.errorCode).toBe("BUDGET")
    engine.close()
  })

  test("cumulative (not delta) accounting survives a repeated total", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 4 })
    const started = await engine.start({ prompt: "steady", budgetUsd: 1 })
    harness.emit({ type: "session.cost", sessionID: started.sessionID, cost: 0.3 })
    await flush()
    // A re-emitted cumulative total replaces the high-water mark instead of
    // adding again: still 0.3, still running.
    harness.emit({ type: "session.cost", sessionID: started.sessionID, cost: 0.3 })
    await flush()
    const record = engine.get(started.handle)
    expect(record.cost).toBeCloseTo(0.3)
    expect(record.status).toBe("running")
    expect(harness.aborts).toEqual([])
    engine.close()
  })

  test("non-finite and negative cost payloads are ignored, never trusted", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 4 })
    const started = await engine.start({ prompt: "steady", budgetUsd: 1 })
    harness.emit({ type: "session.cost", sessionID: started.sessionID, cost: Number.NaN })
    harness.emit({ type: "session.cost", sessionID: started.sessionID, cost: -5 })
    await flush()
    const record = engine.get(started.handle)
    expect(record.cost).toBe(0)
    expect(record.status).toBe("running")
    engine.close()
  })

  test("engine default cap applies without a per-start override", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, {
      maxConcurrentTasks: 4,
      taskBudgetUsd: 0.001,
    })
    const started = await engine.start({ prompt: "spendy" })
    expect(engine.get(started.handle).budgetUsd).toBe(0.001)
    harness.emit({ type: "session.cost", sessionID: started.sessionID, cost: 0.01 })
    await flush()
    expect(engine.get(started.handle).errorCode).toBe("BUDGET")
    engine.close()
  })

  test("the built-in default cap is sane and documented", () => {
    expect(DEFAULT_TASK_BUDGET_USD).toBe(5)
  })

  test("a negative per-start budget is rejected at start time", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 4 })
    let message = ""
    try {
      await engine.start({ prompt: "work", budgetUsd: -1 })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("non-negative")
    engine.close()
  })

  test("cost events for terminal tasks are dropped", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 4 })
    const started = await engine.start({ prompt: "work" })
    harness.sessions.get(started.sessionID)!.busy = false
    harness.sessions.get(started.sessionID)!.assistant.push("done")
    harness.emit({ type: "session.idle", sessionID: started.sessionID })
    await flush()
    expect(engine.get(started.handle).status).toBe("done")
    harness.emit({ type: "session.cost", sessionID: started.sessionID, cost: 100 })
    await flush()
    const record = engine.get(started.handle)
    expect(record.status).toBe("done")
    expect(record.cost).toBe(0)
    engine.close()
  })
})
