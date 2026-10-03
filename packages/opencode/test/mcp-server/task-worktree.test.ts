// Worktree isolation tests (Milestone C2, gap-plan §4.5 + C2 acceptance).
//
// No mocks of git anywhere: every test runs against a REAL tmp git repo
// (fixture tmpdir({ git: true }) plus one committed file). The engine half
// uses the same in-memory EngineSessionClient harness shape as
// task-engine.test.ts — the harness is test scaffolding for the session
// layer, while git itself is always real.

import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import * as path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { TaskEngine, SharedWriteConflictError } from "../../src/mcp-server/task-engine"
import type {
  EngineEvent,
  EngineEventSource,
  EngineSessionClient,
  EngineSessionMessage,
  PendingQuestion,
} from "../../src/mcp-server/task-engine"
import { createGitWorktreeManager, WorktreeConflictError } from "../../src/mcp-server/worktree"

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`))
      else resolve(String(stdout))
    })
  })
}

async function worktreePaths(root: string): Promise<string[]> {
  const out = await git(["worktree", "list", "--porcelain"], root)
  const paths: string[] = []
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(path.resolve(line.slice("worktree ".length).trim()))
  }
  return paths
}

class Harness implements EngineSessionClient {
  sessions = new Map<string, { prompts: string[]; busy: boolean; assistant: string[]; metadata: Record<string, string> }>()
  createdDirectories: string[] = []
  promptDirectories: string[] = []
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

  async createSession(input: {
    title?: string
    metadata: Record<string, string>
    agent?: string
    model?: string
    directory?: string
  }) {
    this.createdDirectories.push(input.directory ?? "(default)")
    const id = `ses_test_${this.next++}`
    this.sessions.set(id, { prompts: [], busy: false, assistant: [], metadata: { ...input.metadata } })
    return { id }
  }

  async promptAsync(input: { sessionID: string; prompt: string; directory?: string }) {
    this.promptDirectories.push(input.directory ?? "(default)")
    const session = this.sessions.get(input.sessionID)
    if (!session) throw new Error("unknown session")
    session.prompts.push(input.prompt)
    session.busy = true
  }

  async abort(input: { sessionID: string }) {
    void input
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

  finish(sessionID: string, text: string): void {
    const session = this.sessions.get(sessionID)!
    session.busy = false
    session.assistant.push(text)
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
}

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("git worktree manager against a real repo", () => {
  test("two parallel worktrees modify the same file without conflict", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "base\n")
    await git(["add", "file.txt"], tmp.path)
    await git(["commit", "-m", "add file"], tmp.path)

    const manager = createGitWorktreeManager(tmp.path)
    const a = await manager.allocate({ name: "task-a" })
    const b = await manager.allocate({ name: "task-b" })
    expect(a.directory).not.toBe(b.directory)

    await Bun.write(path.join(a.directory, "file.txt"), "from task a\n")
    await Bun.write(path.join(b.directory, "file.txt"), "from task b\n")
    expect(await Bun.file(path.join(a.directory, "file.txt")).text()).toBe("from task a\n")
    expect(await Bun.file(path.join(b.directory, "file.txt")).text()).toBe("from task b\n")
    // The main checkout is untouched.
    expect(await Bun.file(path.join(tmp.path, "file.txt")).text()).toBe("base\n")

    const listed = await worktreePaths(tmp.path)
    expect(listed).toContain(path.resolve(a.directory))
    expect(listed).toContain(path.resolve(b.directory))

    // Both checkouts are dirty now, so release preserves them.
    expect(await manager.release(a.directory)).toBe("preserved-dirty")
    expect(await manager.release(b.directory)).toBe("preserved-dirty")
  })

  test("cleanup removes only clean worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const manager = createGitWorktreeManager(tmp.path)

    const clean = await manager.allocate({ name: "clean" })
    expect(await manager.isClean(clean.directory)).toBe(true)
    expect(await manager.release(clean.directory)).toBe("removed")
    expect(await worktreePaths(tmp.path)).not.toContain(path.resolve(clean.directory))

    const dirty = await manager.allocate({ name: "dirty" })
    await Bun.write(path.join(dirty.directory, "new-file.txt"), "uncommitted\n")
    expect(await manager.isClean(dirty.directory)).toBe(false)
    expect(await manager.release(dirty.directory)).toBe("preserved-dirty")
    // Still a registered worktree: nothing was deleted.
    expect(await worktreePaths(tmp.path)).toContain(path.resolve(dirty.directory))
    expect(await Bun.file(path.join(dirty.directory, "new-file.txt")).text()).toBe("uncommitted\n")

    const modified = await manager.allocate({ name: "modified" })
    const tracked = path.join(modified.directory, "tracked.txt")
    await Bun.write(tracked, "v1\n")
    await git(["add", "tracked.txt"], modified.directory)
    await git(["commit", "-m", "tracked"], modified.directory)
    await Bun.write(tracked, "v2\n")
    expect(await manager.release(modified.directory)).toBe("preserved-dirty")
    expect(await worktreePaths(tmp.path)).toContain(path.resolve(modified.directory))
  })

  test("a taken worktree name rejects with a usable suggestion", async () => {
    await using tmp = await tmpdir({ git: true })
    const manager = createGitWorktreeManager(tmp.path)
    await manager.allocate({ name: "shared-name" })
    let error: unknown
    try {
      await manager.allocate({ name: "shared-name" })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WorktreeConflictError)
    const conflict = error as WorktreeConflictError
    expect(conflict.code).toBe("WORKTREE_IN_USE")
    expect(conflict.suggestion).not.toBe("shared-name")
    expect(conflict.message).toContain(conflict.suggestion)
    // The suggestion allocates cleanly.
    const retry = await manager.allocate({ name: conflict.suggestion })
    expect(retry.name).toBe(conflict.suggestion)
  })

  test("allocate fails closed outside a git repository", async () => {
    await using tmp = await tmpdir()
    const manager = createGitWorktreeManager(tmp.path)
    // Fail-closed behavior, not message text: git's phrasing varies by
    // version (and a repo without HEAD fails at `worktree add` instead of
    // the top-level check), so pin the rejection, not the string.
    await expect(manager.allocate()).rejects.toThrow()
  })

  test("release never deletes a worktree it did not allocate", async () => {
    await using tmp = await tmpdir({ git: true })
    const outsider = path.join(tmp.path, "foreign")
    await git(["worktree", "add", outsider], tmp.path)
    const manager = createGitWorktreeManager(tmp.path)
    expect(await manager.release(outsider)).toBe("preserved-dirty")
    expect(await worktreePaths(tmp.path)).toContain(path.resolve(outsider))
  })
})

describe("task engine worktree wiring", () => {
  test("worktree task runs scoped to its checkout; cancel releases it", async () => {
    await using tmp = await tmpdir({ git: true })
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, {
      maxConcurrentTasks: 4,
      worktrees: createGitWorktreeManager(tmp.path),
    })
    const started = await engine.start({ prompt: "edit things", isolation: "worktree", permission: "edits" })
    expect(started.isolation).toBe("worktree")
    const dir = started.worktree?.directory ?? ""
    expect(dir).toContain("mcp-worktrees")
    // The session was created and prompted inside the checkout.
    expect(harness.createdDirectories.at(-1)).toBe(dir)
    expect(harness.promptDirectories.at(-1)).toBe(dir)
    // The binding survives in session metadata for rehydrate.
    expect(harness.sessions.get(started.sessionID)!.metadata["mcp_worktree"]).toBe(dir)

    await engine.cancel(started.handle)
    expect(engine.get(started.handle).status).toBe("cancelled")
    // Clean checkout: removed from the git list.
    expect(await worktreePaths(tmp.path)).not.toContain(path.resolve(started.worktree!.directory))
    engine.close()
  })

  test("a second shared writer is rejected with a worktree suggestion", async () => {
    await using tmp = await tmpdir({ git: true })
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, {
      maxConcurrentTasks: 4,
      worktrees: createGitWorktreeManager(tmp.path),
    })
    await engine.start({ prompt: "first writer", permission: "edits" })
    let error: unknown
    try {
      await engine.start({ prompt: "second writer", permission: "edits" })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SharedWriteConflictError)
    expect((error as SharedWriteConflictError).code).toBe("SHARED_WRITE_CONFLICT")
    expect((error as Error).message).toContain('isolation "worktree"')
    // Read-only tasks never collide with the writer.
    const reader = await engine.start({ prompt: "read only" })
    expect(reader.status).toBe("running")
    engine.close()
  })

  test("worktree name collision through the engine rejects with a suggestion", async () => {
    await using tmp = await tmpdir({ git: true })
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, {
      maxConcurrentTasks: 4,
      worktrees: createGitWorktreeManager(tmp.path),
    })
    await engine.start({ prompt: "first", isolation: "worktree", worktreeName: "same" })
    let error: unknown
    try {
      await engine.start({ prompt: "second", isolation: "worktree", worktreeName: "same" })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(WorktreeConflictError)
    expect((error as WorktreeConflictError).suggestion.length).toBeGreaterThan(0)
    engine.close()
  })

  test("worktree isolation without a manager fails closed", async () => {
    const harness = new Harness()
    const engine = new TaskEngine(harness, harness.store, harness.events, { maxConcurrentTasks: 4 })
    let message = ""
    try {
      await engine.start({ prompt: "work", isolation: "worktree" })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('isolation "worktree" is not configured')
    engine.close()
  })

  test("dirty worktree output survives task completion", async () => {
    await using tmp = await tmpdir({ git: true })
    const harness = new Harness()
    const cleanups: Array<{ handle: string; sessionID: string; worktreePath?: string; disposition?: string }> = []
    const engine = new TaskEngine(harness, harness.store, harness.events, {
      maxConcurrentTasks: 4,
      worktrees: createGitWorktreeManager(tmp.path),
      onWorktreeCleanup: (input) => {
        cleanups.push(input)
      },
    })
    const started = await engine.start({ prompt: "edit things", isolation: "worktree" })
    const dir = started.worktree!.directory
    await Bun.write(path.join(dir, "output.txt"), "agent output\n")
    harness.finish(started.sessionID, "finished work")
    harness.emit({ type: "session.idle", sessionID: started.sessionID })
    // Worktree settlement runs real git I/O inside the engine drain, so a
    // fixed microtask flush cannot observe it: wait on the published
    // readiness signal (the cleanup hook) instead of wall-clock time.
    const deadline = Date.now() + 30_000
    while (cleanups.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(cleanups.length).toBe(1)
    expect(engine.get(started.handle).status).toBe("done")
    // Dirty: preserved, still registered, content intact.
    expect(await worktreePaths(tmp.path)).toContain(path.resolve(dir))
    expect(await Bun.file(path.join(dir, "output.txt")).text()).toBe("agent output\n")
    expect(cleanups).toEqual([
      { handle: started.handle, sessionID: started.sessionID, worktreePath: dir, disposition: "preserved-dirty" },
    ])
    engine.close()
  })
})
