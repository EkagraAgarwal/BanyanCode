// Phase 1 MCP delegation lifecycle tests.
//
// Deterministic fake SessionClient: no live model, no network, no
// http-recorder cassettes needed. The canned assistant transcript stands in
// for a recorded provider turn; the lifecycle, token cap, needs_input and
// timeout behavior under test are identical either way.

import { describe, expect, test } from "bun:test"
import {
  assertWithinPolicy,
  clampWaitSeconds,
  createTaskStore,
  policyReplyFor,
  taskCancel,
  taskReply,
  taskResult,
  taskStart,
  taskStatus,
} from "../../src/mcp-server/tasks"
import type { PendingQuestion, SessionClient, SessionMessage, TaskStore } from "../../src/mcp-server/tasks"
import { buildCompactResult, DEFAULT_RESULT_MAX_TOKENS, estimateTokens } from "../../src/mcp-server/result"

class FakeSessionClient implements SessionClient {
  sessions = new Map<string, { metadata: Record<string, string>; prompts: string[]; aborted: boolean }>()
  busy = new Set<string>()
  assistantBySession = new Map<string, string>()
  pendingBySession = new Map<string, PendingQuestion[]>()
  diffBySession = new Map<string, Array<{ path: string; additions: number; deletions: number; patch?: string }>>()
  permissionReplies: Array<{ sessionID: string; requestID: string; reply: string }> = []
  questionReplies: Array<{ sessionID: string; requestID: string; message: string }> = []
  questionRejects: Array<{ sessionID: string; requestID: string }> = []
  promptCalls = 0
  next = 1

  async createSession(input: { title?: string; metadata: Record<string, string> }): Promise<{ id: string }> {
    const id = `ses_fake_${this.next++}`
    this.sessions.set(id, { metadata: input.metadata, prompts: [], aborted: false })
    return { id }
  }

  async promptAsync(input: { sessionID: string; prompt: string }): Promise<void> {
    this.sessions.get(input.sessionID)?.prompts.push(input.prompt)
    this.busy.add(input.sessionID)
  }

  async prompt(input: { sessionID: string; prompt: string }): Promise<void> {
    this.promptCalls++
    this.sessions.get(input.sessionID)?.prompts.push(input.prompt)
    this.busy.add(input.sessionID)
  }

  async abort(input: { sessionID: string }): Promise<void> {
    const session = this.sessions.get(input.sessionID)
    if (session) session.aborted = true
    this.busy.delete(input.sessionID)
  }

  async sessionStatus(input: { sessionID: string }): Promise<"busy" | "idle"> {
    return this.busy.has(input.sessionID) ? "busy" : "idle"
  }

  finish(sessionID: string, text: string): void {
    this.busy.delete(sessionID)
    this.assistantBySession.set(sessionID, text)
  }

  async messages(input: { sessionID: string; limit?: number }): Promise<SessionMessage[]> {
    const session = this.sessions.get(input.sessionID)
    const out: SessionMessage[] = []
    for (const prompt of session?.prompts ?? []) out.push({ role: "user", text: prompt })
    const final = this.assistantBySession.get(input.sessionID)
    if (final !== undefined) out.push({ role: "assistant", text: final })
    return input.limit !== undefined ? out.slice(-input.limit) : out
  }

  async diff(input: { sessionID: string }): Promise<Array<{ path: string; additions: number; deletions: number }>> {
    return this.diffBySession.get(input.sessionID) ?? []
  }

  async todo(): Promise<Array<{ title: string; status: string }>> {
    return []
  }

  async pending(input: { sessionID: string }): Promise<PendingQuestion[]> {
    return this.pendingBySession.get(input.sessionID) ?? []
  }

  async subagents(): Promise<Array<{ agent: string; model: string; status: string }>> {
    return [{ agent: "explore", model: "test/model", status: "done" }]
  }

  async cost(): Promise<{ cost: number; tokensByModel: Record<string, { input: number; output: number }> }> {
    return { cost: 0.001, tokensByModel: { "test/model": { input: 100, output: 50 } } }
  }

  async replyPermission(input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }): Promise<void> {
    this.permissionReplies.push({ sessionID: input.sessionID, requestID: input.requestID, reply: input.reply })
    this.pendingBySession.set(
      input.sessionID,
      (this.pendingBySession.get(input.sessionID) ?? []).filter((item) => item.requestID !== input.requestID),
    )
  }

  async rejectQuestion(input: { sessionID: string; requestID: string }): Promise<void> {
    this.questionRejects.push({ sessionID: input.sessionID, requestID: input.requestID })
    this.pendingBySession.set(
      input.sessionID,
      (this.pendingBySession.get(input.sessionID) ?? []).filter((item) => item.requestID !== input.requestID),
    )
  }

  async replyQuestion(input: { sessionID: string; requestID: string; message: string }): Promise<void> {
    this.questionReplies.push({ sessionID: input.sessionID, requestID: input.requestID, message: input.message })
    this.pendingBySession.set(
      input.sessionID,
      (this.pendingBySession.get(input.sessionID) ?? []).filter((item) => item.requestID !== input.requestID),
    )
  }
}

function setup(opts?: { maxConcurrentTasks?: number; needsInputTimeoutMs?: number }): { store: TaskStore; client: FakeSessionClient } {
  let now = 1_000_000
  const store = createTaskStore({
    ...opts,
    now: () => now,
    sleep: async () => {
      now += 250
    },
    pollIntervalMs: 250,
  })
  return { store, client: new FakeSessionClient() }
}

describe("mcp task lifecycle", () => {
  test("start -> status -> result -> cancel", async () => {
    const { store, client } = setup()
    const started = await taskStart(store, client, { prompt: "summarize the repo" }, { mcpClient: "claude-code" })
    expect(started.status).toBe("running")

    const record = store.tasks.get(started.task_id)
    expect(record?.origin).toBe("mcp")
    expect(client.sessions.get(started.task_id)?.metadata).toEqual({ origin: "mcp", mcp_client: "claude-code" })

    client.finish(started.task_id, "done: summarized the repo")
    const status = await taskStatus(store, client, started.task_id)
    expect(status.status).toBe("done")

    const result = await taskResult(store, client, started.task_id)
    expect(result.task_id).toBe(started.task_id)
    expect(result.summary).toContain("summarized the repo")
    expect(result.subagentCount).toBe(1)
    expect(result.cost).toBe(0.001)

    const cancelled = await taskCancel(store, client, started.task_id)
    expect(cancelled.status).toBe("cancelled")
    expect(client.sessions.get(started.task_id)?.aborted).toBe(true)
  })

  test("summary stays under the token cap on a multi-file task", async () => {
    const { store, client } = setup()
    const started = await taskStart(store, client, { prompt: "refactor everything" }, {})
    const bigMessage = "refactored. " + "x".repeat(20_000)
    client.finish(started.task_id, bigMessage)
    client.diffBySession.set(
      started.task_id,
      Array.from({ length: 12 }, (_, index) => ({
        path: `src/file${index}.ts`,
        additions: 40 + index,
        deletions: 10 + index,
        patch: `@@ patch ${index} @@\n` + "+line\n".repeat(200),
      })),
    )
    const result = await taskResult(store, client, started.task_id, "summary")
    expect(estimateTokens(result.summary)).toBeLessThanOrEqual(DEFAULT_RESULT_MAX_TOKENS)
    expect(result.truncated).toBe(true)
    expect(result.filesChanged).toHaveLength(12)
    // Summary detail carries counts but no patch content.
    expect(result.filesChanged.every((file) => file.patch === undefined)).toBe(true)
    expect(result.totalAdditions).toBeGreaterThan(0)
  })

  test("detail diff includes patches within the cap", async () => {
    const { store, client } = setup()
    const started = await taskStart(store, client, { prompt: "fix it" }, {})
    client.finish(started.task_id, "fixed")
    client.diffBySession.set(started.task_id, [{ path: "src/a.ts", additions: 3, deletions: 1, patch: "+new\n-old\n" }])
    const result = await taskResult(store, client, started.task_id, "diff")
    expect(result.filesChanged[0]?.patch).toContain("+new")
  })

  test("needs_input then reply then resume", async () => {
    const { store, client } = setup()
    const started = await taskStart(store, client, { prompt: "ask me something" }, {})
    client.pendingBySession.set(started.task_id, [
      { requestID: "q1", kind: "question", title: "Which directory?", askedAt: 1_000_000 },
    ])
    const status = await taskStatus(store, client, started.task_id)
    expect(status.status).toBe("needs_input")
    expect(status.pendingQuestion?.requestID).toBe("q1")

    const resumed = await taskReply(store, client, started.task_id, { answer: "packages/core" })
    expect(resumed.status).toBe("running")
    expect(client.questionReplies).toEqual([{ sessionID: started.task_id, requestID: "q1", message: "packages/core" }])
    // Reply continues the same session: a follow-up prompt lands on the root session.
    expect(client.sessions.get(started.task_id)?.prompts).toContain("packages/core")
  })

  test("needs_input times out to reject", async () => {
    const { store, client } = setup({ needsInputTimeoutMs: 1_000 })
    const started = await taskStart(store, client, { prompt: "needs approval" }, {})
    client.pendingBySession.set(started.task_id, [
      { requestID: "p1", kind: "permission", title: "Write src/a.ts?", askedAt: 0 },
    ])
    const status = await taskStatus(store, client, started.task_id)
    expect(status.status).toBe("running")
    expect(client.permissionReplies).toEqual([{ sessionID: started.task_id, requestID: "p1", reply: "reject" }])
  })

  test("caller approval cannot escalate beyond the reject policy", async () => {
    const { store, client } = setup()
    const started = await taskStart(store, client, { prompt: "write code" }, {})
    client.pendingBySession.set(started.task_id, [
      { requestID: "p9", kind: "permission", title: "Write src/b.ts?", askedAt: 1_000_000 },
    ])
    await taskStatus(store, client, started.task_id)
    await taskReply(store, client, started.task_id, { answer: "approve" })
    expect(client.permissionReplies).toEqual([{ sessionID: started.task_id, requestID: "p9", reply: "reject" }])
  })

  test("over-cap starts queue instead of failing", async () => {
    const { store, client } = setup({ maxConcurrentTasks: 1 })
    const first = await taskStart(store, client, { prompt: "first" }, {})
    expect(first.status).toBe("running")
    const second = await taskStart(store, client, { prompt: "second" }, {})
    expect(second.status).toBe("queued")
  })

  test("wait_seconds is bounded to 0-50", () => {
    expect(clampWaitSeconds(undefined)).toBe(0)
    expect(clampWaitSeconds(-5)).toBe(0)
    expect(clampWaitSeconds(10)).toBe(10)
    expect(clampWaitSeconds(999)).toBe(50)
  })

  test("yolo without the server flag is rejected", async () => {
    const { store, client } = setup()
    await expect(taskStart(store, client, { prompt: "x", permission: "yolo" }, {})).rejects.toThrow("--allow-yolo")
  })

  test("policy helpers never grant beyond reject in Phase 1", () => {
    expect(policyReplyFor("reject", false)).toBe("reject")
    expect(policyReplyFor("edits", false)).toBe("reject")
    expect(policyReplyFor("yolo", false)).toBe("reject")
    expect(assertWithinPolicy("reject", "approve", false)).toBe("reject")
    expect(assertWithinPolicy("reject", "reject", false)).toBe("reject")
  })

  test("compact builder truncates with a marker", () => {
    const result = buildCompactResult({ task_id: "t", status: "done", finalMessage: "y".repeat(10_000) }, { maxTokens: 100 })
    expect(result.truncated).toBe(true)
    expect(result.summary).toContain("[truncated]")
    expect(estimateTokens(result.summary)).toBeLessThanOrEqual(100)
  })
})
