// Covers gap-plan §3 items 11-15: worktree shape, transcript paging,
// file-list trimming under the cap, verification/memory passthrough,
// and the estimatedTokens rename.

import { describe, expect, test } from "bun:test"
import {
  buildCompactResult,
  DEFAULT_RESULT_MAX_TOKENS,
  estimateTokens,
  parseResultCursor,
} from "../../src/mcp-server/result"
import type { DiffFileInput, TranscriptMessageInput } from "../../src/mcp-server/result"
import { createTaskStore, taskResult, taskStart } from "../../src/mcp-server/tasks"
import type { PendingQuestion, SessionClient, SessionMessage, TaskStore } from "../../src/mcp-server/tasks"

function bigDiffFiles(count: number): DiffFileInput[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file${index}.ts`,
    additions: 10 + (index % 50),
    deletions: 5,
    patch: `@@ patch ${index} @@\n` + "+line\n".repeat(100),
  }))
}

function fullJsonTokens(result: unknown): number {
  return estimateTokens(JSON.stringify(result))
}

class TinyClient implements SessionClient {
  id = "ses_cap_1"
  transcript: SessionMessage[] = [{ role: "assistant", text: "done" }]
  isolation = "shared"

  async createSession(): Promise<{ id: string }> {
    return { id: this.id }
  }
  async promptAsync(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  async sessionStatus(): Promise<"busy" | "idle"> {
    return "idle"
  }
  async messages(): Promise<SessionMessage[]> {
    return this.transcript
  }
  async diff(): Promise<DiffFileInput[]> {
    return []
  }
  async todo(): Promise<Array<{ title: string; status: string }>> {
    return []
  }
  async pending(): Promise<PendingQuestion[]> {
    return []
  }
  async subagents(): Promise<Array<{ agent: string; model: string; status: string }>> {
    return []
  }
  async cost(): Promise<{ cost: number; tokensByModel: Record<string, { input: number; output: number }> }> {
    return { cost: 0, tokensByModel: {} }
  }
  async replyPermission(): Promise<void> {}
  async rejectQuestion(): Promise<void> {}
  async replyQuestion(): Promise<void> {}
}

function setup(): { store: TaskStore; client: TinyClient } {
  return { store: createTaskStore(), client: new TinyClient() }
}

describe("mcp result cap", () => {
  test("300-file diff stays within cap with omittedFiles count", () => {
    const files = bigDiffFiles(300)
    for (const detail of ["summary", "diff"] as const) {
      const result = buildCompactResult({ task_id: "t", status: "done", finalMessage: "big refactor", diffFiles: files }, { detail })
      expect(result.estimatedTokens).toBeLessThanOrEqual(DEFAULT_RESULT_MAX_TOKENS)
      expect(fullJsonTokens(result)).toBeLessThanOrEqual(DEFAULT_RESULT_MAX_TOKENS)
      expect(result.omittedFiles).toBe(300 - result.filesChanged.length)
      expect(result.omittedFiles).toBeGreaterThan(0)
      expect(result.truncated).toBe(true)
      expect(result.totalAdditions).toBe(files.reduce((sum, file) => sum + file.additions, 0))
      expect(result.totalDeletions).toBe(files.reduce((sum, file) => sum + file.deletions, 0))
      const churns = result.filesChanged.map((file) => file.additions + file.deletions)
      expect([...churns].sort((a, b) => b - a)).toEqual(churns)
      if (detail === "summary") expect(result.filesChanged.every((file) => file.patch === undefined)).toBe(true)
    }
  })

  test("transcript pages are stable, round-trip via cursor, and end terminal", () => {
    const transcript: TranscriptMessageInput[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index} ` + "x".repeat(400),
    }))
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = buildCompactResult(
        { task_id: "t", status: "done", transcript },
        { detail: "transcript", maxTokens: 300, ...(cursor !== undefined ? { cursor } : {}) },
      )
      expect(result.transcript).toBeDefined()
      expect(result.estimatedTokens).toBeLessThanOrEqual(300)
      expect(fullJsonTokens(result)).toBeLessThanOrEqual(300)
      const messages = result.transcript?.messages ?? []
      expect(messages.length).toBeGreaterThan(0)
      // Stable: the same cursor reproduces the same page.
      const again = buildCompactResult(
        { task_id: "t", status: "done", transcript },
        { detail: "transcript", maxTokens: 300, ...(cursor !== undefined ? { cursor } : {}) },
      )
      expect(again.transcript).toEqual(result.transcript)
      for (const msg of messages) {
        expect(msg.text).toContain(`message ${msg.index} `)
        seen.push(msg.text)
      }
      const next = result.transcript?.nextCursor
      if (next === undefined) break
      expect(parseResultCursor(next)).toBe(messages[0]!.index + messages.length)
      cursor = next
    }
    expect(seen).toHaveLength(10)
    expect(cursor).toBeDefined()
  })

  test("transcript empty page is terminal", () => {
    const transcript: TranscriptMessageInput[] = [{ role: "assistant", text: "only" }]
    const pastEnd = buildCompactResult({ task_id: "t", status: "done", transcript }, { detail: "transcript", cursor: "99" })
    expect(pastEnd.transcript?.messages).toEqual([])
    expect(pastEnd.transcript?.nextCursor).toBeUndefined()
    const empty = buildCompactResult({ task_id: "t", status: "done", transcript: [] }, { detail: "transcript" })
    expect(empty.transcript?.messages).toEqual([])
    expect(empty.transcript?.nextCursor).toBeUndefined()
  })

  test("transcript detail differs from summary; other details omit it", () => {
    const transcript: TranscriptMessageInput[] = [{ role: "assistant", text: "hello" }]
    const paged = buildCompactResult({ task_id: "t", status: "done", finalMessage: "hello", transcript }, { detail: "transcript" })
    expect(paged.transcript?.messages).toHaveLength(1)
    const summary = buildCompactResult({ task_id: "t", status: "done", finalMessage: "hello", transcript }, { detail: "summary" })
    expect(summary.transcript).toBeUndefined()
  })

  test("worktree reports the real path or is omitted", () => {
    const withTree = buildCompactResult(
      { task_id: "t", status: "done", worktree: { path: "/repo/.banyancode/worktrees/wt-1", branch: "task-x" } },
      {},
    )
    expect(withTree.worktree).toEqual({ path: "/repo/.banyancode/worktrees/wt-1", branch: "task-x" })
    const without = buildCompactResult({ task_id: "t", status: "done" }, {})
    expect(without.worktree).toBeUndefined()
  })

  test("verification and memory pass through when provided, omitted otherwise", () => {
    const filled = buildCompactResult(
      {
        task_id: "t",
        status: "done",
        verification: { kind: "test", passed: true, counts: "3 passed" },
        memory: [{ id: "mem_1", title: "decision" }],
      },
      {},
    )
    expect(filled.verification).toEqual({ kind: "test", passed: true, counts: "3 passed" })
    expect(filled.memory).toEqual([{ id: "mem_1", title: "decision" }])
    const bare = buildCompactResult({ task_id: "t", status: "done" }, {})
    expect(bare.verification).toBeUndefined()
    expect(bare.memory).toBeUndefined()
  })

  test("token estimate is estimatedTokens with a matching alias", () => {
    const result = buildCompactResult({ task_id: "t", status: "done", finalMessage: "hi" }, {})
    expect(typeof result.estimatedTokens).toBe("number")
    expect(result.tokens).toBe(result.estimatedTokens)
  })

  test("taskResult never reports the session ID as the worktree", async () => {
    const { store, client } = setup()
    const started = await taskStart(store, client, { prompt: "work in isolation", isolation: "worktree" }, {})
    const bare = await taskResult(store, client, started.task_id)
    expect(bare.worktree).toBeUndefined()
    const withTree = await taskResult(store, client, started.task_id, "summary", {
      worktree: { path: "/repo/.banyancode/worktrees/wt-9", branch: "task-9" },
      verification: { kind: "typecheck", passed: true },
      memory: [{ id: "mem_9" }],
    })
    expect(withTree.worktree).toEqual({ path: "/repo/.banyancode/worktrees/wt-9", branch: "task-9" })
    expect(withTree.verification).toEqual({ kind: "typecheck", passed: true })
    expect(withTree.memory).toEqual([{ id: "mem_9" }])
  })

  test("taskResult transcript pages round-trip through the cursor", async () => {
    const { store, client } = setup()
    client.transcript = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `turn ${index} ` + "y".repeat(300),
    }))
    const smallStore = createTaskStore({ resultMaxTokens: 300 })
    const started = await taskStart(smallStore, client, { prompt: "chatty" }, {})
    const first = await taskResult(smallStore, client, started.task_id, "transcript")
    expect((first.transcript?.messages.length ?? 0)).toBeGreaterThan(0)
    expect(first.estimatedTokens).toBeLessThanOrEqual(300)
    if (first.transcript?.nextCursor !== undefined) {
      const second = await taskResult(smallStore, client, started.task_id, "transcript", {
        cursor: first.transcript.nextCursor,
      })
      expect(second.transcript?.messages[0]?.index).toBe(
        (first.transcript.messages.length ?? 0) + (first.transcript.messages[0]?.index ?? 0),
      )
      expect(second.estimatedTokens).toBeLessThanOrEqual(300)
    }
  })
})
