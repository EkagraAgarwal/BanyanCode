// MCP task tools: protocol tests (Milestone B slice).
//
// Real McpServer + real MCP Client over an InMemoryTransport linked pair,
// handlers driving the real TaskEngine. The session layer is the same
// in-memory harness shape as task-engine.test.ts (test scaffolding for the
// port, not a mock of production logic): one FakeSessions class implements
// both the engine port and the tasks-port reader, backed by a shared store.
// No mocked transports, no mocked engine.

import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { MCP_ERAS, forEachEra, withEraClient } from "./era-harness"
import { TaskEngine } from "../../src/mcp-server/task-engine"
import type {
  EngineEvent,
  EngineSessionClient,
  EngineSessionMessage,
  EngineSessionLookup,
  PendingQuestion,
} from "../../src/mcp-server/task-engine"
import { TaskToolNames, registerTaskTools } from "../../src/mcp-server/tools-task"
import type { TaskToolsConfig, TaskToolsDeps } from "../../src/mcp-server/tools-task"
import { newTaskHandle, assertHandleShape } from "../../src/mcp-server/task-handle"
import type { SessionClient, SessionMessage } from "../../src/mcp-server/types"
import type { DiffFileInput } from "../../src/mcp-server/result"
import {
  isToolGroupEnabled,
  mcpSessionMetadata,
  mcpSessionTitle,
  resolveMcpServerConfig,
} from "../../src/mcp-server/server"

// One store implementing both ports (engine lifecycle + tasks-port reads).
class FakeSessions implements EngineSessionClient {
  sessions = new Map<
    string,
    { prompts: string[]; busy: boolean; assistant: string[]; metadata: Record<string, string>; title?: string }
  >()
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

  readonly events = {
    subscribe: (handler: (event: EngineEvent) => void) => {
      this.listeners.push(handler)
      return () => {
        this.listeners = this.listeners.filter((l) => l !== handler)
      }
    },
  }

  emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  readonly store: EngineSessionLookup = {
    findSession: async (input: { sessionID: string }) => {
      const session = this.sessions.get(input.sessionID)
      return session ? { metadata: { ...session.metadata } } : undefined
    },
    listMcpSessions: async () => {
      const out: Array<{ sessionID: string; metadata: Record<string, string> }> = []
      for (const [sessionID, session] of this.sessions) {
        if (session.metadata["origin"] === "mcp") out.push({ sessionID, metadata: { ...session.metadata } })
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
    this.sessions.set(id, {
      prompts: [],
      busy: false,
      assistant: [],
      metadata: { ...input.metadata },
      title: input.title,
    })
    return { id }
  }

  async promptAsync(input: { sessionID: string; prompt: string }) {
    const session = this.sessions.get(input.sessionID)
    if (!session) throw new Error("unknown session")
    session.prompts.push(input.prompt)
    session.busy = true
  }

  async prompt(input: { sessionID: string; prompt: string }) {
    return this.promptAsync(input)
  }

  async abort(input: { sessionID: string }) {
    this.sessions.get(input.sessionID)!.busy = false
  }

  async sessionStatus(input: { sessionID: string }) {
    return this.sessions.get(input.sessionID)?.busy ? ("busy" as const) : ("idle" as const)
  }

  async messages(input: { sessionID: string; limit?: number }): Promise<SessionMessage[]> {
    const session = this.sessions.get(input.sessionID)
    const out: SessionMessage[] = []
    for (const prompt of session?.prompts ?? []) out.push({ role: "user", text: prompt })
    for (const text of session?.assistant ?? []) out.push({ role: "assistant", text })
    return input.limit !== undefined ? out.slice(-input.limit) : out
  }

  finish(sessionID: string, text: string): void {
    const session = this.sessions.get(sessionID)!
    session.busy = false
    session.assistant.push(text)
  }

  async diff(input: { sessionID: string }): Promise<DiffFileInput[]> {
    void input.sessionID
    return [{ path: "src/widget.ts", additions: 10, deletions: 2 }]
  }

  async todo(input: { sessionID: string }) {
    void input.sessionID
    return [{ title: "wire the widget", status: "completed" }]
  }

  async pending(input: { sessionID: string }): Promise<PendingQuestion[]> {
    return this.pendingBySession.get(input.sessionID) ?? []
  }

  async subagents(input: { sessionID: string }) {
    void input.sessionID
    return [{ agent: "build", model: "test/model", status: "idle" }]
  }

  async cost(input: { sessionID: string }) {
    void input.sessionID
    return { cost: 0.01, tokensByModel: { "test/model": { input: 100, output: 50 } } }
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

const baseConfig = (patch?: Partial<TaskToolsConfig>): TaskToolsConfig => ({
  permission: "reject",
  allowYolo: false,
  resultMaxTokens: 1500,
  outputChars: 8000,
  ...patch,
})

const setupEngine = (fake: FakeSessions, opts?: { maxConcurrentTasks?: number }) =>
  new TaskEngine(fake, fake.store, fake.events, { maxConcurrentTasks: opts?.maxConcurrentTasks ?? 4 })

const depsFor = (engine: TaskEngine, fake: FakeSessions, patch?: Partial<TaskToolsConfig>): TaskToolsDeps => ({
  engine,
  sessions: fake as unknown as SessionClient,
  directory: "/repo",
  updateMetadata: (input) => fake.writeMetadata(input),
  getMcpClientName: () => "test-client",
  config: baseConfig(patch),
})

// One connected protocol pair per era (gap-plan D0): legacy (`initialize`
// over InMemoryTransport) and modern (`server/discover` then per-request
// `_meta` through an in-process handler). Fixtures are fresh per era —
// engines, handles and the shared-writer guard are process state, so
// reusing one engine across eras would reject the second era's
// write-capable shared start (correct server behavior, but a polluted
// test). One engine serves both surfaces within an era. Failures are
// tagged with the era that failed.
export type TaskFixtures = { fake: FakeSessions; engine: TaskEngine; deps: TaskToolsDeps }

const taskClientInfo = { name: "tools-task-test-client", version: "0.0.0-test" } as const

const buildTaskServer = (deps: TaskToolsDeps): McpServer => {
  const mcp = new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
  registerTaskTools(mcp, deps)
  return mcp
}

async function withTaskProtocol(
  setup: () => TaskFixtures,
  body: (fx: TaskFixtures, client: Client) => Promise<unknown>,
): Promise<void> {
  for (const era of MCP_ERAS) {
    const fx = setup()
    try {
      await withEraClient(
        era,
        () => buildTaskServer(fx.deps),
        taskClientInfo,
        (client) => body(fx, client),
      )
    } finally {
      fx.engine.close()
    }
  }
}

const freshTaskSetup =
  (patch?: Partial<TaskToolsConfig>, opts?: { maxConcurrentTasks?: number }): (() => TaskFixtures) =>
  () => {
    const fake = new FakeSessions()
    const engine = setupEngine(fake, opts)
    return { fake, engine, deps: depsFor(engine, fake, patch) }
  }

type McpTextResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const toolText = (result: unknown): string => {
  const r = result as McpTextResult
  return r.content[0]?.text ?? ""
}

const toolJson = <T>(result: unknown): T => JSON.parse(toolText(result)) as T

const isToolError = (result: unknown): boolean => (result as McpTextResult).isError === true

describe("mcp task tools", () => {
  test("lists the five banyan_task_ tools in stable alphabetical order", async () => {
    await withTaskProtocol(freshTaskSetup(), async (_fx, client) => {
      const first = await client.listTools()
      const second = await client.listTools()
      expect(first.tools.map((t) => t.name)).toEqual([...TaskToolNames])
      expect(first.tools.map((t) => t.name)).toEqual([...first.tools.map((t) => t.name)].sort())
      expect(second.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name))
      for (const tool of first.tools) {
        expect(typeof tool.title).toBe("string")
        expect(tool.title?.length).toBeGreaterThan(0)
        expect(tool.description).toContain("UNKNOWN_TASK")
        expect(tool.annotations?.readOnlyHint).toBe(false)
        expect(tool.annotations?.openWorldHint).toBe(false)
        expect(tool.annotations?.destructiveHint).toBe(tool.name === "banyan_task_cancel")
        expect(tool.outputSchema).toBeDefined()
        expect(tool.outputSchema?.type).toBe("object")
        const meta = tool._meta as Record<string, unknown> | undefined
        expect(meta?.["anthropic/maxResultSizeChars"]).toBe(8000)
      }
    })
  })

  test("lifecycle smoke: start → status → cancel", async () => {
    await withTaskProtocol(freshTaskSetup(), async ({ fake, engine }, client) => {
      const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "do the thing" } })
      expect(isToolError(started)).toBe(false)
      const startBody = toolJson<{ task_id: string; status: string }>(started)
      // Opaque handle: btask_ shape, never the raw ses_ id (E0).
      assertHandleShape(startBody.task_id)
      expect(startBody.task_id).not.toContain("ses_")
      expect(startBody.status).toBe("running")

      // B7 (engine side): origin/mcp_client metadata flow into the created
      // session; the [mcp] title prefix and policy/isolation defaults are
      // applied by the server wiring adapter (unit-tested below).
      const record = engine.get(startBody.task_id)
      const stored = fake.sessions.get(record.sessionID)!
      expect(stored.metadata["origin"]).toBe("mcp")
      expect(stored.metadata["mcp_client"]).toBe("test-client")
      // mcp_handle binding (E2): the engine writes it at start; the
      // tools layer repairs it when the write did not land.
      expect(stored.metadata["mcp_handle"]).toBe(startBody.task_id)
      // Creation-time ruleset passthrough (E1): the server policy reaches
      // session creation as a built ruleset.
      const created = fake.createdInputs.at(-1)!
      expect(created.permission).toBeDefined()
      expect(created.permission!.length).toBeGreaterThan(0)

      const status = await client.callTool({ name: "banyan_task_status", arguments: { task_id: startBody.task_id } })
      expect(isToolError(status)).toBe(false)
      expect(toolJson<{ task_id: string; status: string }>(status).status).toBe("running")

      const cancelled = await client.callTool({ name: "banyan_task_cancel", arguments: { task_id: startBody.task_id } })
      expect(isToolError(cancelled)).toBe(false)
      expect(toolJson<{ task_id: string; status: string }>(cancelled).status).toBe("cancelled")

      const after = await client.callTool({ name: "banyan_task_status", arguments: { task_id: startBody.task_id } })
      expect(toolJson<{ status: string }>(after).status).toBe("cancelled")
    })
  })

  test("unknown handles are UNKNOWN_TASK with recovery text", async () => {
    await withTaskProtocol(freshTaskSetup(), async (_fx, client) => {
      for (const taskID of ["nope", newTaskHandle()]) {
        const unknown = await client.callTool({ name: "banyan_task_status", arguments: { task_id: taskID } })
        expect(isToolError(unknown)).toBe(true)
        expect(toolText(unknown)).toContain("UNKNOWN_TASK")
        expect(toolText(unknown)).toContain("banyan_task_start")
      }
    })
  })

  test("reply uses the typed decision, not free-text matching", async () => {
    await withTaskProtocol(freshTaskSetup({ permission: "edits" }), async ({ fake, engine }, client) => {
      const started = await client.callTool({
        name: "banyan_task_start",
        arguments: { prompt: "edit things", permission: "edits" },
      })
      expect(isToolError(started)).toBe(false)
      const taskID = toolJson<{ task_id: string }>(started).task_id
      const sessionID = engine.get(taskID).sessionID
      fake.pendingBySession.set(sessionID, [
        { requestID: "perm-1", kind: "permission", title: "write file", askedAt: Date.now() },
      ])

      const status = await client.callTool({ name: "banyan_task_status", arguments: { task_id: taskID } })
      expect(toolJson<{ status: string }>(status).status).toBe("needs_input")

      // The message text contains "approve" twice; the typed decision
      // (reject) is the only signal the engine may use.
      const replied = await client.callTool({
        name: "banyan_task_reply",
        arguments: { task_id: taskID, decision: "reject", message: "approve approve" },
      })
      expect(isToolError(replied)).toBe(false)
      expect(fake.permissionReplies.at(-1)?.reply).toBe("reject")

      // Approving a question without an answer message is an argument error.
      fake.pendingBySession.set(sessionID, [
        { requestID: "q-1", kind: "question", title: "which file?", askedAt: Date.now() },
      ])
      await client.callTool({ name: "banyan_task_status", arguments: { task_id: taskID } })
      const missing = await client.callTool({
        name: "banyan_task_reply",
        arguments: { task_id: taskID, decision: "approve" },
      })
      expect(isToolError(missing)).toBe(true)
      expect(toolText(missing)).toContain("INVALID_ARGUMENTS")
    })
  })

  test("agent/model allowlists and permission mismatch are enforced", async () => {
    await withTaskProtocol(
      freshTaskSetup({ allowedAgents: ["build"], allowedModels: ["test/model"] }),
      async (_fx, client) => {
        const badAgent = await client.callTool({
          name: "banyan_task_start",
          arguments: { prompt: "x", agent: "evil" },
        })
        expect(isToolError(badAgent)).toBe(true)
        expect(toolText(badAgent)).toContain("POLICY_REJECTED")

        const badModel = await client.callTool({
          name: "banyan_task_start",
          arguments: { prompt: "x", model: "evil/model" },
        })
        expect(isToolError(badModel)).toBe(true)
        expect(toolText(badModel)).toContain("POLICY_REJECTED")

        const mismatch = await client.callTool({
          name: "banyan_task_start",
          arguments: { prompt: "x", permission: "edits" },
        })
        expect(isToolError(mismatch)).toBe(true)
        expect(toolText(mismatch)).toContain("INVALID_ARGUMENTS")

        const yolo = await client.callTool({
          name: "banyan_task_start",
          arguments: { prompt: "x", permission: "yolo" },
        })
        expect(isToolError(yolo)).toBe(true)
        expect(toolText(yolo)).toContain("POLICY_REJECTED")
        expect(toolText(yolo)).toContain("--allow-yolo")
      },
    )
  })

  test("wait_seconds is capped at 50 by the schema", async () => {
    await withTaskProtocol(freshTaskSetup(), async (_fx, client) => {
      const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "slow work" } })
      const taskID = toolJson<{ task_id: string }>(started).task_id
      const rejected = await client
        .callTool({ name: "banyan_task_status", arguments: { task_id: taskID, wait_seconds: 500 } })
        .then((result) => (isToolError(result) ? ("rejected" as const) : ("accepted" as const)))
        .catch(() => "rejected" as const)
      expect(rejected).toBe("rejected")

      // A 1 s long-poll stays far under the 120 s auto-background threshold.
      const before = Date.now()
      const waited = await client.callTool({
        name: "banyan_task_status",
        arguments: { task_id: taskID, wait_seconds: 1 },
      })
      const elapsed = Date.now() - before
      expect(isToolError(waited)).toBe(false)
      expect(toolJson<{ status: string }>(waited).status).toBe("running")
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(10_000)
    })
  })

  test("status long-poll returns on the state change, not the deadline (E4)", async () => {
    await withTaskProtocol(freshTaskSetup(), async ({ fake, engine }, client) => {
      const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "quick work" } })
      const taskID = toolJson<{ task_id: string }>(started).task_id
      const sessionID = engine.get(taskID).sessionID
      // Finish the task mid-poll: the 10 s long-poll must resolve on the
      // transition, far short of its deadline.
      setTimeout(() => {
        fake.finish(sessionID, "all done")
        fake.emit({ type: "session.idle", sessionID })
      }, 100)
      const before = Date.now()
      const waited = await client.callTool({
        name: "banyan_task_status",
        arguments: { task_id: taskID, wait_seconds: 10 },
      })
      const elapsed = Date.now() - before
      expect(isToolError(waited)).toBe(false)
      expect(toolJson<{ status: string }>(waited).status).toBe("done")
      expect(elapsed).toBeLessThan(5000)
    })
  })

  test("task_result builds the compact result with transcript paging", async () => {
    await withTaskProtocol(freshTaskSetup(), async ({ fake, engine }, client) => {
      const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "do work" } })
      const taskID = toolJson<{ task_id: string }>(started).task_id
      fake.finish(engine.get(taskID).sessionID, "all done")

      const summary = await client.callTool({ name: "banyan_task_result", arguments: { task_id: taskID } })
      expect(isToolError(summary)).toBe(false)
      const compact = toolJson<{
        task_id: string
        status: string
        filesChanged: Array<{ path: string }>
        totalAdditions: number
        estimatedTokens: number
        cost: number
        subagentCount: number
      }>(summary)
      expect(compact.task_id).toBe(taskID)
      expect(compact.filesChanged[0]?.path).toBe("src/widget.ts")
      expect(compact.totalAdditions).toBe(10)
      expect(compact.estimatedTokens).toBeGreaterThan(0)
      expect(compact.cost).toBe(0.01)
      expect(compact.subagentCount).toBe(1)
      // The raw session id never leaks to the caller.
      expect(JSON.stringify(compact)).not.toContain("ses_test_")

      const transcript = await client.callTool({
        name: "banyan_task_result",
        arguments: { task_id: taskID, detail: "transcript" },
      })
      expect(isToolError(transcript)).toBe(false)
      const page = toolJson<{ transcript: { messages: Array<{ index: number; role: string }> } }>(transcript)
      expect(page.transcript.messages.length).toBe(2)
      expect(page.transcript.messages[0]?.index).toBe(0)
    })
  })

  test("a restarted engine rehydrates the handle from session metadata", async () => {
    // Both phases run inside each era: the first engine starts the task,
    // the second rehydrates it from the shared session store.
    for (const era of MCP_ERAS) {
      const fake = new FakeSessions()
      const first = setupEngine(fake)
      let taskID = ""
      try {
        await withEraClient(
          era,
          () => buildTaskServer(depsFor(first, fake)),
          taskClientInfo,
          async (client) => {
            const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "long work" } })
            taskID = toolJson<{ task_id: string }>(started).task_id
          },
        )
      } finally {
        first.close()
      }
      const second = setupEngine(fake)
      try {
        await withEraClient(
          era,
          () => buildTaskServer(depsFor(second, fake)),
          taskClientInfo,
          async (client) => {
            const status = await client.callTool({ name: "banyan_task_status", arguments: { task_id: taskID } })
            expect(isToolError(status)).toBe(false)
            expect(toolJson<{ task_id: string; status: string }>(status)).toEqual(
              expect.objectContaining({ task_id: taskID, status: "running" }),
            )
          },
        )
      } finally {
        second.close()
      }
    }
  })

  test("group allowlist: a disabled task group hides the tools", async () => {
    expect(isToolGroupEnabled(undefined, "task")).toBe(true)
    expect(isToolGroupEnabled(["code", "task"], "task")).toBe(true)
    expect(isToolGroupEnabled(["code"], "task")).toBe(false)
    expect(isToolGroupEnabled([], "code")).toBe(false)

    // The disabled branch registers nothing task-shaped: a server wired
    // without registerTaskTools lists zero banyan_task_* tools, in both
    // eras. (With zero tools total the legacy server answers Method not
    // found — that also proves nothing task-shaped is listed.)
    const buildEmpty = () => new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
    await forEachEra(buildEmpty, { name: "tools-task-test-client", version: "0.0.0-test" }, async (client) => {
      let names: string[] = []
      let methodNotFound = false
      try {
        const { tools } = await client.listTools()
        names = tools.map((t) => t.name)
      } catch (error) {
        methodNotFound = String(error).includes("-32601")
      }
      expect(names.filter((n) => n.startsWith("banyan_task_"))).toEqual([])
      expect(names.length === 0 || methodNotFound).toBe(true)
    })
  })

  test("B7 session identity helpers: [mcp] title prefix and metadata defaults", async () => {
    expect(mcpSessionTitle("do the thing")).toBe("[mcp] do the thing")
    expect(mcpSessionTitle("[mcp] already")).toBe("[mcp] already")
    expect(mcpSessionTitle(undefined)).toBe("[mcp] mcp task")
    expect(mcpSessionMetadata({ policy: "reject", metadata: { mcp_client: "claude-code" } })).toEqual({
      policy: "reject",
      isolation: "shared",
      mcp_client: "claude-code",
      origin: "mcp",
    })
    // Engine-supplied markers win over the defaults; origin is forced.
    expect(mcpSessionMetadata({ policy: "reject", metadata: { origin: "spoof", mcp_state: "running" } })).toEqual({
      policy: "reject",
      isolation: "shared",
      mcp_state: "running",
      origin: "mcp",
    })
  })

  test("resolveMcpServerConfig defaults to reject-everything and honors overrides", async () => {
    const defaults = await resolveMcpServerConfig()
    expect(defaults.permission).toBe("reject")
    expect(defaults.maxConcurrentTasks).toBeGreaterThan(0)
    expect(defaults.resultMaxTokens).toBeGreaterThan(0)
    expect(defaults.needsInputTimeoutMs).toBeGreaterThan(0)
    expect(defaults.outputChars).toBeGreaterThan(0)
    expect(defaults.toolGroups).toBeUndefined()
    expect(isToolGroupEnabled(defaults.toolGroups, "task")).toBe(true)

    const narrowed = await resolveMcpServerConfig({ permission: "edits", toolGroups: ["code"] })
    expect(narrowed.permission).toBe("edits")
    expect(isToolGroupEnabled(narrowed.toolGroups, "task")).toBe(false)
    expect(isToolGroupEnabled(narrowed.toolGroups, "code")).toBe(true)
  })
})
