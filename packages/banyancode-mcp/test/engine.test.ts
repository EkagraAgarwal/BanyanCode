import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { TaskEngine, SharedWriteConflictError, UnknownTaskError } from "../src/engine"
import { resolveConfig, type ResolvedConfig } from "../src/config"
import { decodeCursor } from "../src/digest"
import { createFakePort, type FakePort, event, form, permission } from "./fake-port"

const cwd = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-engine-"))

const baseConfig = (): ResolvedConfig =>
  resolveConfig({ cwd, configPath: path.join(cwd, "missing.json"), env: {} })

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const base = baseConfig()
  return { ...base, ...overrides, autonomy: { ...base.autonomy, ...(overrides.autonomy ?? {}) } }
}

type Harness = { engine: TaskEngine; port: FakePort; clock: () => number; advance: (ms: number) => void; close: () => void }

const harness = (options: { config?: Partial<ResolvedConfig>; port?: FakePort } = {}): Harness => {
  let now = 1_000_000
  const port = options.port ?? createFakePort({ projects: [{ id: "prj_1", canonical: cwd }] })
  const engine = new TaskEngine({
    port,
    config: config(options.config),
    root: cwd,
    now: () => now,
    sweepIntervalMs: 60_000,
    needsInputTimeoutMs: 600_000,
  })
  return {
    engine,
    port,
    clock: () => now,
    advance: (ms: number) => {
      now += ms
    },
    close: () => engine.close(),
  }
}

const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await Bun.sleep(5)
  }
}

describe("TaskEngine start", () => {
  test("creates a tagged session at the project root and prompts it", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "fix the bug\nwith context", mcpClient: "claude-code" })
    expect(record.status).toBe("running")
    expect(record.phase).toBe("executing")
    expect(record.sessionID.startsWith("ses_")).toBe(true)
    const session = h.port.sessions.get(record.sessionID)!
    expect(session.metadata.origin).toBe("banyan-mcp")
    expect(session.metadata.banyan_task).toBe(record.handle)
    expect(session.metadata.mcp_client).toBe("claude-code")
    expect(session.location).toBe(cwd)
    expect(session.title).toBe("[banyan] fix the bug")
    expect(h.port.calls.prompt).toHaveLength(1)
    expect(h.port.calls.prompt[0]?.text).toBe("fix the bug\nwith context")
    h.close()
  })

  test("agent/model/autonomy/budget land on the session and the record", async () => {
    const h = harness()
    const record = await h.engine.start({
      prompt: "x",
      agent: "coder",
      model: "anthropic/claude",
      autonomy: "trusted",
      budget: { max_steps: 7, max_cost: 0.5, timeout_s: 60 },
    })
    expect(record.agent).toBe("coder")
    expect(record.model).toBe("anthropic/claude")
    expect(record.autonomy).toBe("trusted")
    expect(record.budget).toEqual({ maxSteps: 7, maxCost: 0.5, timeoutMs: 60_000 })
    const session = h.port.sessions.get(record.sessionID)!
    expect(session.agent).toBe("coder")
    expect(session.model).toBe("anthropic/claude")
    h.close()
  })

  test("unknown autonomy profiles and disallowed agents are rejected", async () => {
    const h = harness({ config: { allowedAgents: ["coder"] } })
    await expect(h.engine.start({ prompt: "x", autonomy: "nope" })).rejects.toThrow(/unknown autonomy profile/)
    await expect(h.engine.start({ prompt: "x", agent: "reviewer" })).rejects.toThrow(/allowed_agents/)
    h.close()
  })

  test("queues past max_concurrent_tasks and starts the next on cancel", async () => {
    const h = harness({ config: { maxConcurrentTasks: 1 } })
    const first = await h.engine.start({ prompt: "first" })
    const second = await h.engine.start({ prompt: "second" })
    expect(first.status).toBe("running")
    expect(second.status).toBe("queued")
    expect(h.port.calls.prompt).toHaveLength(1)
    await h.engine.cancel(first.handle)
    await waitUntil(() => h.port.calls.prompt.length === 2)
    expect(h.engine.get(second.handle).status).toBe("running")
    h.close()
  })

  test("a second write-capable shared task is refused", async () => {
    const h = harness({ config: { permission: "edits", maxConcurrentTasks: 4 } })
    const first = await h.engine.start({ prompt: "one", autonomy: "trusted" })
    await expect(h.engine.start({ prompt: "two", autonomy: "trusted" })).rejects.toBeInstanceOf(
      SharedWriteConflictError,
    )
    await h.engine.cancel(first.handle)
    h.close()
  })

  test("a supervised task that only asks for edits does not take the writer slot", async () => {
    const h = harness({ config: { permission: "edits", maxConcurrentTasks: 4 } })
    const first = await h.engine.start({ prompt: "one" })
    const second = await h.engine.start({ prompt: "two" })
    expect(second.status).toBe("running")
    await h.engine.cancel(first.handle)
    await h.engine.cancel(second.handle)
    h.close()
  })

  test("worktree: new allocates a checkout, roots the session there, and removes it on cancel", async () => {
    const h = harness({ config: { worktree: "new" } })
    const record = await h.engine.start({ prompt: "isolated" })
    expect(h.port.calls.createWorktree).toHaveLength(1)
    expect(h.port.sessions.get(record.sessionID)?.location).toBe(h.port.worktreeDirectory)
    expect(record.isolation).toBe("worktree")
    await h.engine.cancel(record.handle)
    expect(h.port.calls.removeWorktree).toEqual([
      { projectID: "prj_1", directory: h.port.worktreeDirectory, force: true },
    ])
    expect(h.engine.get(record.handle).worktree).toBeUndefined()
    h.close()
  })

  test("worktree as a path runs there without creating or removing a checkout", async () => {
    const h = harness()
    const directory = path.join(cwd, "nested", "dir")
    const record = await h.engine.start({ prompt: "pinned dir", worktree: "nested/dir" })
    expect(h.port.calls.createWorktree).toHaveLength(0)
    expect(h.port.sessions.get(record.sessionID)?.location).toBe(directory)
    await h.engine.cancel(record.handle)
    expect(h.port.calls.removeWorktree).toHaveLength(0)
    h.close()
  })
})

describe("TaskEngine status and replies", () => {
  test("a pending permission surfaces as needs_input and approve grants once", async () => {
    const h = harness({ config: { permission: "edits" } })
    const record = await h.engine.start({ prompt: "edit" })
    h.port.addPermission(record.sessionID, permission("per_1", "edit", ["src/a.ts"]))
    const status = await h.engine.status(record.handle)
    expect(status.status).toBe("needs_input")
    expect(status.pending).toHaveLength(1)
    expect(status.pending[0]?.title).toBe("edit src/a.ts")
    await h.engine.reply(record.handle, { decision: "approve" })
    expect(h.port.calls.replyPermission.at(-1)).toEqual({
      sessionID: record.sessionID,
      requestID: "per_1",
      decision: "once",
    })
    expect(h.engine.get(record.handle).pending).toHaveLength(0)
    h.close()
  })

  test("approve never widens beyond a reject-everything policy", async () => {
    const h = harness({ config: { permission: "reject" } })
    const record = await h.engine.start({ prompt: "edit" })
    h.port.addPermission(record.sessionID, permission("per_1", "edit", ["src/a.ts"]))
    await h.engine.reply(record.handle, { decision: "approve" })
    expect(h.port.calls.replyPermission.at(-1)?.decision).toBe("reject")
    h.close()
  })

  test("a question form is answered from free text", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "ask" })
    h.port.addForm(form("form_1", record.sessionID, ["q0"]))
    const status = await h.engine.status(record.handle)
    expect(status.status).toBe("needs_input")
    expect(status.pending[0]?.kind).toBe("question")
    await h.engine.reply(record.handle, { decision: "approve", message: "postgres" })
    expect(h.port.calls.replyForm.at(-1)).toEqual({
      sessionID: record.sessionID,
      formID: "form_1",
      answer: { q0: "postgres" },
    })
    h.close()
  })

  test("rejecting a question cancels the form", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "ask" })
    h.port.addForm(form("form_1", record.sessionID))
    await h.engine.status(record.handle)
    await h.engine.reply(record.handle, { decision: "reject" })
    expect(h.port.calls.cancelForm.at(-1)).toMatchObject({ formID: "form_1" })
    h.close()
  })

  test("a free-text reply with nothing pending steers the task", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "work" })
    await h.engine.reply(record.handle, { message: "focus on tests", delivery: "steer" })
    expect(h.port.calls.prompt.at(-1)).toEqual({
      sessionID: record.sessionID,
      text: "focus on tests",
      delivery: "steer",
    })
    h.close()
  })

  test("a permission.asked event for an allowing profile is auto-answered", async () => {
    const h = harness({
      config: {
        autonomy: {
          default: "supervised",
          auto_answer_after_seconds: 0,
          profiles: {
            trusted: { rules: [{ action: "edit", resource: "*", effect: "allow" }] },
          },
        },
      },
    })
    const record = await h.engine.start({ prompt: "auto", autonomy: "trusted" })
    h.port.emit({
      type: "permission.asked",
      sessionID: record.sessionID,
      ask: { id: "per_9", action: "edit", resources: ["src/a.ts"], title: "edit src/a.ts" },
    })
    await waitUntil(() => h.port.calls.replyPermission.length === 1)
    expect(h.port.calls.replyPermission[0]).toMatchObject({ requestID: "per_9", decision: "once" })
    h.close()
  })

  test("form.created and form.closed events move the task in and out of needs_input", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "ask" })
    h.port.emit({
      type: "form.created",
      sessionID: record.sessionID,
      form: { id: "form_2", title: "Pick one" },
    })
    await waitUntil(() => h.engine.get(record.handle).status === "needs_input")
    expect(h.engine.get(record.handle).pending[0]?.title).toBe("Pick one")
    h.port.emit({ type: "form.closed", sessionID: record.sessionID, formID: "form_2" })
    await waitUntil(() => h.engine.get(record.handle).status === "running")
    h.close()
  })
})

describe("TaskEngine budget", () => {
  test("a cost overrun fails the task with BUDGET_COST and interrupts the session", async () => {
    const h = harness({ config: { taskBudgetUsd: 1 } })
    const record = await h.engine.start({ prompt: "spend" })
    h.port.sessions.get(record.sessionID)!.cost = 2.5
    const { report } = await h.engine.checkup({ cursorState: {} })
    const task = report.tasks.find((item) => item.task_id === record.handle)!
    expect(task.status).toBe("failed")
    expect(h.port.calls.interrupt).toContain(record.sessionID)
    expect(h.engine.get(record.handle).errorCode).toBe("BUDGET_COST")
    expect(report.terminal.map((item) => item.task_id)).toContain(record.handle)
    h.close()
  })

  test("a per-start step cap trips from the digest", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "steps", budget: { max_steps: 2 } })
    const session = h.port.sessions.get(record.sessionID)!
    session.log = [event(1, "session.step.started"), event(2, "session.step.started"), event(3, "session.step.started")]
    await h.engine.checkup({ cursorState: {} })
    expect(h.engine.get(record.handle).status).toBe("failed")
    expect(h.engine.get(record.handle).errorCode).toBe("BUDGET_STEPS")
    h.close()
  })

  test("a timeout cap trips on wall clock", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "slow", budget: { timeout_s: 10 } })
    h.advance(11_000)
    await h.engine.checkup({ cursorState: {} })
    expect(h.engine.get(record.handle).errorCode).toBe("BUDGET_TIMEOUT")
    h.close()
  })
})

describe("TaskEngine checkup", () => {
  test("digest advances only with new events, and the cursor round-trips", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "work" })
    const session = h.port.sessions.get(record.sessionID)!
    session.log = [
      event(1, "session.step.started"),
      event(2, "session.tool.called", { name: "edit", input: { filePath: "src/a.ts" } }),
      event(3, "session.text.ended", { text: "wip" }),
    ]
    const first = await h.engine.checkup({ cursorState: {} })
    const task = first.report.tasks.find((item) => item.task_id === record.handle)!
    expect(task.progress.steps).toBe(1)
    expect(task.progress.tool_calls).toBe(1)
    expect(task.progress.files).toEqual(["src/a.ts"])
    expect(task.progress.last_text).toBe("wip")
    expect(decodeCursor(first.report.cursor)[record.handle]).toBe(3)

    session.log.push(event(4, "session.step.started"))
    const second = await h.engine.checkup({ cursorState: decodeCursor(first.report.cursor) })
    const next = second.report.tasks.find((item) => item.task_id === record.handle)!
    expect(next.progress.steps).toBe(1)
    expect(decodeCursor(second.report.cursor)[record.handle]).toBe(4)

    const third = await h.engine.checkup({ cursorState: decodeCursor(second.report.cursor) })
    const empty = third.report.tasks.find((item) => item.task_id === record.handle)!
    expect(empty.progress.steps).toBe(0)
    expect(empty.progress.tool_calls).toBe(0)
    h.close()
  })

  test("terminal tasks are reported once", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "done" })
    await h.engine.cancel(record.handle)
    const first = await h.engine.checkup({ cursorState: {} })
    expect(first.report.terminal.map((item) => item.task_id)).toContain(record.handle)
    const second = await h.engine.checkup({ cursorState: {} })
    expect(second.report.terminal).toHaveLength(0)
    h.close()
  })

  test("no durable progress for minutes is reported as stuck", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "hang" })
    const session = h.port.sessions.get(record.sessionID)!
    session.active = true
    session.log = [event(1, "session.step.started", {}, h.clock())]
    h.advance(6 * 60_000)
    const { report } = await h.engine.checkup({ cursorState: {} })
    const task = report.tasks.find((item) => item.task_id === record.handle)!
    expect(task.stuck?.kind).toBe("no_progress")
    expect(task.next_checkup_in_s).toBe(60)
    h.close()
  })

  test("three identical tool calls in a row are reported as a loop", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "loop" })
    const session = h.port.sessions.get(record.sessionID)!
    session.active = true
    const input = { filePath: "src/a.ts", old: "x", new: "y" }
    session.log = [1, 2, 3].map((seq) => event(seq, "session.tool.called", { name: "edit", input }, h.clock()))
    const { report } = await h.engine.checkup({ cursorState: {} })
    const task = report.tasks.find((item) => item.task_id === record.handle)!
    expect(task.stuck?.kind).toBe("loop")
    h.close()
  })

  test("a needs_input task gets the fast checkup interval and its asks", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "ask" })
    h.port.addPermission(record.sessionID, permission("per_1", "edit", ["a.ts"]))
    await h.engine.status(record.handle)
    h.advance(1_000)
    const { report } = await h.engine.checkup({ cursorState: {} })
    const task = report.tasks.find((item) => item.task_id === record.handle)!
    expect(task.status).toBe("needs_input")
    expect(task.pending[0]?.id).toBe("per_1")
    expect(task.pending[0]?.age_s).toBeGreaterThanOrEqual(1)
    expect(task.next_checkup_in_s).toBe(30)
    h.close()
  })
})

describe("TaskEngine result", () => {
  test("result stands alone by rebuilding counters from the transcript", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "result" })
    const session = h.port.sessions.get(record.sessionID)!
    session.messages = [
      { id: "m1", type: "user", role: "user", text: "go", created: 1 },
      {
        id: "m2",
        type: "assistant",
        role: "assistant",
        text: "finished the change",
        created: 2,
        cost: 0.03,
        tokens: { input: 9, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        tools: [{ name: "edit", input: { filePath: "src/result.ts" } }],
      },
    ]
    const result = await h.engine.result(record.handle, "summary")
    expect(result.summary.steps).toBe(1)
    expect(result.summary.tool_calls).toBe(1)
    expect(result.summary.files_changed).toBe(1)
    expect(result.summary.last_text).toBe("finished the change")
    h.close()
  })

  test("diff detail summarizes and caps patches", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "diff" })
    h.port.diff = async () => [
      { file: "a.ts", patch: "x".repeat(10_000), additions: 2, deletions: 1, status: "modified" },
    ]
    const result = await h.engine.result(record.handle, "diff")
    expect(result.summary.additions).toBe(2)
    expect(result.summary.deletions).toBe(1)
    expect(result.diff?.[0]?.file).toBe("a.ts")
    expect((result.diff?.[0]?.patch?.length ?? 0)).toBeLessThan(10_000)
    h.close()
  })

  test("transcript detail pages messages", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "transcript" })
    const session = h.port.sessions.get(record.sessionID)!
    session.messages = Array.from({ length: 60 }, (_, index) => ({
      id: `m${index}`,
      type: index % 2 === 0 ? "user" : "assistant",
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index}`,
      created: index,
    }))
    const page = await h.engine.result(record.handle, "transcript")
    expect(page.transcript?.messages.length).toBeGreaterThan(0)
    expect(page.transcript?.cursor).toBeDefined()
    const next = await h.engine.result(record.handle, "transcript", page.transcript?.cursor)
    expect(next.transcript?.messages[0]?.text).not.toBe(page.transcript?.messages[0]?.text)
    h.close()
  })
})

describe("TaskEngine subagent asks", () => {
  test("an ask from a v2 subagent session resolves to the parent task and replies on that session", async () => {
    const h = harness()
    const parent = await h.engine.start({ prompt: "parent" })
    const child = await h.port.createSession({ parentID: parent.sessionID, metadata: {}, directory: cwd })
    h.port.addPermission(child.id, permission("per_2", "edit", ["src/child.ts"]))
    h.port.emit({
      type: "permission.asked",
      sessionID: child.id,
      ask: { id: "per_2", action: "edit", resources: ["src/child.ts"], title: "edit src/child.ts" },
    })
    await waitUntil(() => h.engine.get(parent.handle).pending.length === 1)
    const ask = h.engine.get(parent.handle).pending[0]!
    expect(ask.sessionID).toBe(child.id)
    await h.engine.reply(parent.handle, { decision: "approve" })
    expect(h.port.calls.replyPermission.at(-1)).toMatchObject({ sessionID: child.id, requestID: "per_2" })
    h.close()
  })

  test("a child task keeps its own handle", async () => {
    const h = harness()
    const parent = await h.engine.start({ prompt: "parent" })
    const [child] = await h.engine.spawn(parent.handle, [{ prompt: "child" }])
    h.port.addPermission(child!.sessionID, permission("per_3", "edit", ["a.ts"]))
    h.port.emit({
      type: "permission.asked",
      sessionID: child!.sessionID,
      ask: { id: "per_3", action: "edit", resources: ["a.ts"], title: "edit a.ts" },
    })
    await waitUntil(() => h.engine.get(child!.handle).pending.length === 1)
    expect(h.engine.get(parent.handle).pending).toHaveLength(0)
    h.close()
  })
})

describe("TaskEngine digest sources", () => {
  test("live durable events feed the digest when the durable log is empty", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "live" })
    const durable = (seq: number, type: string, data: Record<string, unknown> = {}) => ({
      type: "durable" as const,
      sessionID: record.sessionID,
      event: event(seq, type, data, h.clock()),
    })
    h.port.emit(durable(1, "session.step.started"))
    h.port.emit(durable(2, "session.tool.called", { name: "edit", input: { filePath: "src/live.ts" } }))
    h.port.emit(durable(3, "session.text.ended", { text: "live text" }))
    await waitUntil(() => h.engine.get(record.handle).live.length === 3)

    const first = await h.engine.checkup({ cursorState: {} })
    const task = first.report.tasks.find((item) => item.task_id === record.handle)!
    expect(task.progress.steps).toBe(1)
    expect(task.progress.files).toEqual(["src/live.ts"])
    expect(task.progress.last_text).toBe("live text")
    expect(decodeCursor(first.report.cursor)[record.handle]).toBe(3)
    // The live buffer is drained by the fold.
    expect(h.engine.get(record.handle).live).toHaveLength(0)

    const second = await h.engine.checkup({ cursorState: decodeCursor(first.report.cursor) })
    const next = second.report.tasks.find((item) => item.task_id === record.handle)!
    expect(next.progress.steps).toBe(0)
  })

  test("restart history falls back to the transcript with a negative cursor", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "history" })
    const session = h.port.sessions.get(record.sessionID)!
    session.messages = [
      { id: "m1", type: "user", role: "user", text: "do it", created: 1 },
      {
        id: "m2",
        type: "assistant",
        role: "assistant",
        text: "first pass",
        created: 2,
        cost: 0.01,
        tokens: { input: 5, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        tools: [{ name: "edit", input: { filePath: "src/a.ts" } }],
      },
    ]
    const first = await h.engine.checkup({ cursorState: {} })
    const task = first.report.tasks.find((item) => item.task_id === record.handle)!
    expect(task.progress.steps).toBe(1)
    expect(task.progress.tool_calls).toBe(1)
    expect(task.progress.last_text).toBe("first pass")
    const cursor = decodeCursor(first.report.cursor)[record.handle]!
    expect(cursor).toBeLessThan(0)

    session.messages.push({
      id: "m3",
      type: "assistant",
      role: "assistant",
      text: "second pass",
      created: 3,
      cost: 0.01,
      tokens: { input: 5, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const second = await h.engine.checkup({ cursorState: decodeCursor(first.report.cursor) })
    const next = second.report.tasks.find((item) => item.task_id === record.handle)!
    expect(next.progress.steps).toBe(1)
    expect(next.progress.last_text).toBe("second pass")

    const third = await h.engine.checkup({ cursorState: decodeCursor(second.report.cursor) })
    const empty = third.report.tasks.find((item) => item.task_id === record.handle)!
    expect(empty.progress.steps).toBe(0)
  })

  test("the durable log wins when the host persists events", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "persisted" })
    const session = h.port.sessions.get(record.sessionID)!
    session.log = [event(1, "session.step.started"), event(2, "session.step.started")]
    session.messages = [
      {
        id: "m1",
        type: "assistant",
        role: "assistant",
        text: "from transcript",
        created: 1,
        tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]
    const { report } = await h.engine.checkup({ cursorState: {} })
    const task = report.tasks.find((item) => item.task_id === record.handle)!
    // Two step.started from the log, zero from the transcript fallback.
    expect(task.progress.steps).toBe(2)
    expect(task.progress.last_text).toBeUndefined()
    expect(decodeCursor(report.cursor)[record.handle]).toBe(2)
  })
})

describe("TaskEngine spawn and tree", () => {
  test("subtasks are child sessions and appear under the parent", async () => {
    const h = harness()
    const parent = await h.engine.start({ prompt: "parent" })
    const children = await h.engine.spawn(parent.handle, [{ prompt: "one" }, { prompt: "two" }])
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(h.port.sessions.get(child.sessionID)?.parentID).toBe(parent.sessionID)
      expect(child.parentHandle).toBe(parent.handle)
    }
    const tree = h.engine.tree()
    expect(tree).toHaveLength(1)
    expect(tree[0]?.task_id).toBe(parent.handle)
    expect(tree[0]?.children.map((node) => node.task_id).sort()).toEqual(children.map((child) => child.handle).sort())
    h.close()
  })

  test("max_subagents caps a fan-out", async () => {
    const h = harness()
    const parent = await h.engine.start({ prompt: "parent", maxSubagents: 1 })
    await expect(h.engine.spawn(parent.handle, [{ prompt: "one" }, { prompt: "two" }])).rejects.toThrow(/max_subagents/)
    h.close()
  })

  test("a terminal parent refuses new subtasks", async () => {
    const h = harness()
    const parent = await h.engine.start({ prompt: "parent" })
    await h.engine.cancel(parent.handle)
    await expect(h.engine.spawn(parent.handle, [{ prompt: "late" }])).rejects.toThrow(/cannot spawn/)
    h.close()
  })
})

describe("TaskEngine rehydrate", () => {
  test("rebuilds handles from session metadata in a fresh engine", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "survive" })
    h.engine.close()

    const second = new TaskEngine({
      port: h.port,
      config: config(),
      root: cwd,
      now: h.clock,
      sweepIntervalMs: 60_000,
    })
    const restored = await second.rehydrateAll()
    expect(restored.map((item) => item.handle)).toContain(record.handle)
    const status = await second.status(record.handle)
    expect(status.sessionID).toBe(record.sessionID)
    expect(status.status).toBe("running")
    await expect(second.status("btask_" + "0".repeat(64))).rejects.toBeInstanceOf(UnknownTaskError)
    second.close()
  })

  test("cancel then rehydrate keeps the terminal state", async () => {
    const h = harness()
    const record = await h.engine.start({ prompt: "cancel me" })
    await h.engine.cancel(record.handle)
    h.engine.close()
    const second = new TaskEngine({ port: h.port, config: config(), root: cwd, now: h.clock, sweepIntervalMs: 60_000 })
    const restored = await second.rehydrateAll()
    expect(restored.find((item) => item.handle === record.handle)?.status).toBe("cancelled")
    second.close()
  })
})
