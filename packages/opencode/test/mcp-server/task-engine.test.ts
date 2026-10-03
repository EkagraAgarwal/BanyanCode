// Task engine regression tests (gap-plan §3 items 1,2,5,6,8,9).
//
// In-memory harness: a fake EngineSessionClient port plus a controllable
// event source. The harness is test scaffolding, not a mock of production
// logic — the engine (queue, state machine, timers, rehydrate) is real.

import { describe, expect, test } from "bun:test"
import { TaskEngine } from "../../src/mcp-server/task-engine"
import { assertHandleShape } from "../../src/mcp-server/task-handle"
import type {
  EngineEvent,
  EngineEventSource,
  EngineSessionClient,
  EngineSessionMessage,
  PendingQuestion,
} from "../../src/mcp-server/task-engine"

class Harness implements EngineSessionClient {
  sessions = new Map<string, { prompts: string[]; busy: boolean; assistant: string[]; metadata: Record<string, string> }>()
  pendingBySession = new Map<string, PendingQuestion[]>()
  permissionReplies: Array<{ sessionID: string; reply: string }> = []
  questionReplies: Array<{ sessionID: string; message: string }> = []
  questionRejects: string[] = []
  next = 1
  listeners: Array<(event: EngineEvent) => void> = []
  createdInputs: Array<{
    title?: string
    metadata: Record<string, string>
    agent?: string
    model?: string
    permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  }> = []

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

  async createSession(input: {
    title?: string
    metadata: Record<string, string>
    agent?: string
    model?: string
    permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  }) {
    this.createdInputs.push(input)
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
    this.sessions.get(input.sessionID)!.busy = false
  }

  async sessionStatus(input: { sessionID: string }) {
    return this.sessions.get(input.sessionID)?.busy ? ("busy" as const) : ("idle" as const)
  }

  async messages(input: { sessionID: string }): Promise<EngineSessionMessage[]> {
    const session = this.sessions.get(input.sessionID)
    const out: EngineSessionMessage[] = []
    for (const prompt of session?.prompts ?? []) out.push({ role: "user", text: prompt })
    for (const text of session?.assistant ?? []) out.push({ role: "assistant", text })
    return out
  }

  finish(sessionID: string, text: string): void {
    const session = this.sessions.get(sessionID)!
    session.busy = false
    session.assistant.push(text)
  }

  async pending(input: { sessionID: string }): Promise<PendingQuestion[]> {
    return this.pendingBySession.get(input.sessionID) ?? []
  }

  async replyPermission(input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }) {
    this.permissionReplies.push({ sessionID: input.sessionID, reply: input.reply })
    this.pendingBySession.set(input.sessionID, [])
  }

  async rejectQuestion(input: { sessionID: string; requestID: string }) {
    this.questionRejects.push(input.requestID)
    this.pendingBySession.set(input.sessionID, [])
  }

  async replyQuestion(input: { sessionID: string; requestID: string; message: string }) {
    this.questionReplies.push({ sessionID: input.sessionID, message: input.message })
    this.pendingBySession.set(input.sessionID, [])
    this.sessions.get(input.sessionID)!.busy = true
  }

  async writeMetadata(input: { sessionID: string; metadata: Record<string, string> }) {
    Object.assign(this.sessions.get(input.sessionID)!.metadata, input.metadata)
  }
}

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(opts?: { maxConcurrentTasks?: number; needsInputTimeoutMs?: number }) {
  const harness = new Harness()
  const engine = new TaskEngine(harness, harness.store, harness.events, {
    maxConcurrentTasks: opts?.maxConcurrentTasks ?? 4,
    ...(opts?.needsInputTimeoutMs !== undefined ? { needsInputTimeoutMs: opts.needsInputTimeoutMs } : {}),
  })
  return { harness, engine }
}

describe("task engine", () => {
  test("queue dequeues when a slot frees (§3.1)", async () => {
    const { harness, engine } = setup({ maxConcurrentTasks: 1 })
    const first = await engine.start({ prompt: "first" })
    const second = await engine.start({ prompt: "second" })
    expect(first.status).toBe("running")
    expect(second.status).toBe("queued")

    harness.finish(first.sessionID, "first done")
    harness.emit({ type: "session.idle", sessionID: first.sessionID })
    await flush()
    expect(engine.get(first.handle).status).toBe("done")
    expect(engine.get(second.handle).status).toBe("running")
    const secondSession = harness.sessions.get(second.sessionID)!
    expect(secondSession.prompts).toEqual(["second"])
    engine.close()
  })

  test("queued task is never reported done before it starts (§3.1)", async () => {
    const { engine } = setup({ maxConcurrentTasks: 1 })
    await engine.start({ prompt: "first" })
    const second = await engine.start({ prompt: "second" })
    const record = await engine.status(second.handle)
    expect(record.status).toBe("queued")
    engine.close()
  })

  test("promptAsync race: idle without a fresh assistant message stays running (§3.2)", async () => {
    const { harness, engine } = setup()
    const started = await engine.start({ prompt: "work" })
    // Run loop hasn't produced output yet; idle alone must not mean done.
    harness.sessions.get(started.sessionID)!.busy = false
    harness.emit({ type: "session.idle", sessionID: started.sessionID })
    await flush()
    expect(engine.get(started.handle).status).toBe("running")

    harness.finish(started.sessionID, "finished work")
    harness.emit({ type: "session.idle", sessionID: started.sessionID })
    await flush()
    expect(engine.get(started.handle).status).toBe("done")
    engine.close()
  })

  test("reject policy auto-rejects without caller poll (§3.3)", async () => {
    const { harness, engine } = setup()
    const started = await engine.start({ prompt: "work", permission: "reject" })
    harness.emit({
      type: "permission.asked",
      sessionID: started.sessionID,
      request: { requestID: "perm-1", kind: "permission", title: "write file", askedAt: Date.now() },
    })
    await flush()
    expect(engine.get(started.handle).status).toBe("running")
    expect(harness.permissionReplies).toEqual([{ sessionID: started.sessionID, reply: "reject" }])
    engine.close()
  })

  test("needs_input timeout fires without caller poll (§3.5)", async () => {
    const { harness, engine } = setup({ needsInputTimeoutMs: 20 })
    const started = await engine.start({ prompt: "work", permission: "edits" })
    harness.emit({
      type: "question.asked",
      sessionID: started.sessionID,
      request: { requestID: "q-1", kind: "question", title: "which file?", askedAt: Date.now() },
    })
    await flush()
    expect(engine.get(started.handle).status).toBe("needs_input")
    await new Promise((resolve) => setTimeout(resolve, 60))
    await flush()
    const record = engine.get(started.handle)
    expect(record.status).toBe("running")
    expect(record.pendingQuestion).toBeUndefined()
    expect(harness.questionRejects).toEqual(["q-1"])
    engine.close()
  })

  test("creation passes agent/model/ruleset through and writes mcp_handle (E1/E2)", async () => {
    const { harness, engine } = setup()
    const ruleset = [{ permission: "question", pattern: "*", action: "ask" as const }]
    const started = await engine.start({
      prompt: "work",
      agent: "build",
      model: "test/model",
      permission: "reject",
      permissionRuleset: ruleset,
    })
    const created = harness.createdInputs.at(-1)!
    expect(created.agent).toBe("build")
    expect(created.model).toBe("test/model")
    expect(created.permission).toEqual(ruleset)
    // The handle↔session binding lands in creation metadata and is
    // repaired through the metadata writer — no caller backfill needed.
    expect(created.metadata["mcp_handle"]).toBe(started.handle)
    expect(harness.sessions.get(started.sessionID)!.metadata["mcp_handle"]).toBe(started.handle)
    engine.close()
  })

  test("rehydrate after restart rebuilds queued and running records (§3.6)", async () => {
    const { harness, engine } = setup({ maxConcurrentTasks: 1 })
    const first = await engine.start({ prompt: "first" })
    const second = await engine.start({ prompt: "second" })
    const secondSession = second.sessionID
    // No manual mcp_handle backfill: the engine wrote it at start (E2).
    expect(harness.sessions.get(secondSession)!.metadata["mcp_handle"]).toBe(second.handle)
    engine.close()

    const restarted = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 1 })
    const records = await restarted.rehydrateAll()
    expect(records.length).toBe(2)
    expect(restarted.get(second.handle).status).toBe("queued")
    expect(harness.sessions.get(secondSession)!.metadata["mcp_state"]).toBe("queued")
    // Single-handle lookup matches the written binding.
    expect((await restarted.rehydrate(first.handle)).sessionID).toBe(first.sessionID)
    restarted.close()
  })

  test("rehydrate adopts a legacy session that carries only origin mcp", async () => {
    const { harness, engine } = setup()
    engine.close()
    // A session from before the engine wrote mcp_handle: origin marker
    // only, no binding yet.
    harness.sessions.set("ses_test_legacy", {
      prompts: ["old work"],
      busy: false,
      assistant: ["old answer"],
      metadata: { origin: "mcp", mcp_client: "old-client", mcp_state: "running" },
    })
    const restarted = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 1 })
    const records = await restarted.rehydrateAll()
    expect(records.length).toBe(1)
    const adopted = records[0]!
    assertHandleShape(adopted.handle)
    // The minted handle is written back, so the next restart matches it.
    expect(harness.sessions.get("ses_test_legacy")!.metadata["mcp_handle"]).toBe(adopted.handle)
    expect((await restarted.rehydrate(adopted.handle)).sessionID).toBe("ses_test_legacy")
    restarted.close()
  })

  test("waitForStateChange resolves on the next state change, not the deadline (E4)", async () => {
    const { harness, engine } = setup()
    const started = await engine.start({ prompt: "work" })
    const waiting = engine.waitForStateChange(started.handle, { timeoutMs: 5000, fromStatus: "running" })
    const before = Date.now()
    harness.finish(started.sessionID, "finished work")
    harness.emit({ type: "session.idle", sessionID: started.sessionID })
    const resolved = await waiting
    expect(resolved.status).toBe("done")
    expect(Date.now() - before).toBeLessThan(2000)
    engine.close()
  })

  test("waitForStateChange resolves with the current record on the deadline", async () => {
    const { engine } = setup()
    const started = await engine.start({ prompt: "work" })
    const before = Date.now()
    // Noop event source, no transitions: the deadline is the only way out.
    const resolved = await engine.waitForStateChange(started.handle, { timeoutMs: 60, fromStatus: "running" })
    expect(resolved.status).toBe("running")
    expect(Date.now() - before).toBeGreaterThanOrEqual(40)
    // Already past fromStatus resolves immediately.
    const immediate = await engine.waitForStateChange(started.handle, { timeoutMs: 5000, fromStatus: "done" })
    expect(immediate.status).toBe("running")
    engine.close()
  })

  test("waitForStateChange on an unknown handle rejects like every other lookup", async () => {
    const { engine } = setup()
    let message = ""
    try {
      await engine.waitForStateChange("nope", { timeoutMs: 10 })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("unknown or expired task handle")
    engine.close()
  })

  test("cancel frees the slot, starts the next queued task, and runs cleanup (§3.9)", async () => {
    const { harness, engine } = setup({ maxConcurrentTasks: 1 })
    let cleaned: Array<{ handle: string; sessionID: string }> = []
    engine.close()
    const harness2 = harness
    const engine2 = new TaskEngine(harness2, harness2.store, harness2.events, {
      maxConcurrentTasks: 1,
      onWorktreeCleanup: (input) => {
        cleaned.push(input)
      },
    })
    const first = await engine2.start({ prompt: "first" })
    const second = await engine2.start({ prompt: "second" })
    await engine2.cancel(first.handle)
    await flush()
    expect(engine2.get(first.handle).status).toBe("cancelled")
    expect(engine2.get(second.handle).status).toBe("running")
    expect(cleaned).toEqual([{ handle: first.handle, sessionID: first.sessionID }])
    engine2.close()
  })

  test("session.error fails the task and frees the slot", async () => {
    const { harness, engine } = setup({ maxConcurrentTasks: 1 })
    const first = await engine.start({ prompt: "first" })
    const second = await engine.start({ prompt: "second" })
    harness.emit({ type: "session.error", sessionID: first.sessionID, message: "boom" })
    await flush()
    expect(engine.get(first.handle).status).toBe("failed")
    expect(engine.get(second.handle).status).toBe("running")
    engine.close()
  })

  test("typed decision drives permission replies, not free text", async () => {
    const { harness, engine } = setup()
    const started = await engine.start({ prompt: "work", permission: "edits" })
    harness.pendingBySession.set(started.sessionID, [
      { requestID: "perm-1", kind: "permission", title: "write file", askedAt: Date.now() },
    ])
    await engine.status(started.handle)
    expect(engine.get(started.handle).status).toBe("needs_input")
    await engine.reply(started.handle, { decision: "reject", message: "nope nope approve" })
    expect(harness.permissionReplies.at(-1)?.reply).toBe("reject")
    engine.close()
  })

  test("handle is opaque btask_ and unknown handles raise a recoverable error", async () => {
    const { harness, engine } = setup()
    const started = await engine.start({ prompt: "work" })
    assertHandleShape(started.handle)
    expect(started.handle).not.toContain("ses_")
    expect(started.sessionID).toContain("ses_")
    // The binding the handle resolves through is the session metadata.
    expect(harness.sessions.get(started.sessionID)!.metadata["mcp_handle"]).toBe(started.handle)
    let message = ""
    try {
      engine.get("nope")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("unknown or expired task handle")
    engine.close()
  })

  test("cancel of a done task keeps its history (§3.9 guard)", async () => {
    const { harness, engine } = setup()
    const started = await engine.start({ prompt: "work" })
    harness.finish(started.sessionID, "finished work")
    harness.emit({ type: "session.idle", sessionID: started.sessionID })
    await flush()
    expect(engine.get(started.handle).status).toBe("done")
    const after = await engine.cancel(started.handle)
    expect(after.status).toBe("done")
    engine.close()
  })
})
