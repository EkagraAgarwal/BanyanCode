// Tasks extension (gap-plan Milestone D1, SEP-2663 `io.modelcontextprotocol/tasks`).
//
// One engine serves both surfaces: `banyan_task_*` stays the fallback for
// clients without the extension, `tasks/*` serves clients whose per-request
// capabilities include it. No `tasks/list` (spec removed it on purpose).
//
// Transport notes (verified against @modelcontextprotocol/server 2.2.0, and
// the reason for the two test styles below):
// - The SDK Client cannot take the extension path: `callTool`/`request`
//   reject `resultType: "task"` on decode, and the modern-era outbound gate
//   refuses to SEND `tasks/*` (legacy vocabulary, not custom methods).
//   Extension wire assertions therefore go through raw JSON-RPC fetch
//   against `createMcpHandler` (modern leg only — the envelope is a
//   2026-07-28 concept). A future SDK with terminal-result handling will be
//   able to drive the same flow through `Client`.
// - `subscriptions/listen` streams are owned by the SDK serving entries,
//   whose filter schema drops `taskIds`. `notifications/tasks` is broadcast
//   best-effort and observed here on the legacy leg (InMemoryTransport);
//   polling `tasks/get` is the primary mechanism on both eras.
// - Legacy clients have no per-request envelope, so they always take the
//   fallback tools and `tasks/*` answers -32021 for them.

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/client"
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  createMcpHandler,
} from "@modelcontextprotocol/server"
import { MCP_ERAS, MODERN_PROTOCOL_VERSION, withEraClient } from "./era-harness"
import { TaskEngine } from "../../src/mcp-server/task-engine"
import type {
  EngineEvent,
  EngineSessionClient,
  EngineSessionLookup,
  PendingQuestion,
  TaskRecord,
} from "../../src/mcp-server/task-engine"
import { registerTaskTools } from "../../src/mcp-server/tools-task"
import type { TaskToolsConfig, TaskToolsDeps } from "../../src/mcp-server/tools-task"
import {
  TASK_POLL_INTERVAL_MS,
  TASK_TTL_MS,
  TasksExtensionID,
  buildInputRequests,
  createTasksExtensionHandlers,
  hasTasksExtension,
  readDetailedTask,
  replyFromInputResponses,
  toCreateTaskResult,
  toExtensionStatus,
} from "../../src/mcp-server/tools-task"
import { assertHandleShape } from "../../src/mcp-server/task-handle"
import type { SessionClient, SessionMessage } from "../../src/mcp-server/types"
import type { DiffFileInput } from "../../src/mcp-server/result"

// Same in-memory harness shape as tools-task.test.ts: one store
// implementing both the engine lifecycle port and the tasks-port reader.
class FakeSessions implements EngineSessionClient {
  sessions = new Map<
    string,
    { prompts: string[]; busy: boolean; assistant: string[]; metadata: Record<string, string>; title?: string }
  >()
  pendingBySession = new Map<string, PendingQuestion[]>()
  failedSessions = new Set<string>()
  permissionReplies: Array<{ sessionID: string; reply: string }> = []
  questionReplies: Array<{ sessionID: string; message: string }> = []
  questionRejects: string[] = []
  next = 1
  listeners: Array<(event: EngineEvent) => void> = []

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
  }) {
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
    if (this.failedSessions.has(input.sessionID)) return "failed" as const
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

const baseConfig = (): TaskToolsConfig => ({
  permission: "reject",
  allowYolo: false,
  resultMaxTokens: 1500,
  outputChars: 8000,
})

type ExtFixtures = { fake: FakeSessions; engine: TaskEngine; deps: TaskToolsDeps }

const freshSetup = (): ExtFixtures => {
  const fake = new FakeSessions()
  const engine = new TaskEngine(fake, fake.store, fake.events, { maxConcurrentTasks: 4 })
  const deps: TaskToolsDeps = {
    engine,
    sessions: fake as unknown as SessionClient,
    directory: "/repo",
    updateMetadata: (input) => fake.writeMetadata(input),
    getMcpClientName: () => "test-client",
    config: baseConfig(),
  }
  return { fake, engine, deps }
}

const taskClientInfo = { name: "tasks-ext-test-client", version: "0.0.0-test" } as const

const buildExtServer = (deps: TaskToolsDeps): McpServer => {
  const mcp = new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
  registerTaskTools(mcp, deps)
  return mcp
}

const loose = z.object({}).passthrough()

type McpTextResult = {
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const toolJson = <T>(result: unknown): T => JSON.parse((result as McpTextResult).content[0]?.text ?? "null") as T
const isToolError = (result: unknown): boolean => (result as McpTextResult).isError === true

// One connected protocol pair per era with PLAIN clients (no tasks
// extension): the fallback surface plus the extension gate. Fresh fixtures
// per era so engine state never leaks across legs.
async function withPlainBothEras(body: (fx: ExtFixtures, client: Client) => Promise<unknown>): Promise<void> {
  for (const era of MCP_ERAS) {
    const fx = freshSetup()
    try {
      await withEraClient(era, () => buildExtServer(fx.deps), taskClientInfo, (client) => body(fx, client))
    } finally {
      fx.engine.close()
    }
  }
}

// Raw JSON-RPC fetch against a modern handler: the only path that can carry
// the extension envelope AND observe `resultType: "task"` (the SDK 2.2.0
// Client rejects both directions). One shared McpServer per test so the
// engine is common to every request.
type RawResponse = { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } }

const rawCall = async (
  handler: { fetch: (req: Request) => Promise<Response> },
  method: string,
  params: Record<string, unknown>,
  opts?: { extensions?: boolean; name?: string },
): Promise<RawResponse> => {
  const withExt = opts?.extensions ?? true
  const req = new Request("http://test.local/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(opts?.name !== undefined ? { "mcp-name": opts.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1_000_000_000),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "tasks-ext-raw", version: "0.0.0-test" },
          "io.modelcontextprotocol/clientCapabilities": withExt
            ? { extensions: { [TasksExtensionID]: {} } }
            : {},
        },
      },
    }),
  })
  const res = await handler.fetch(req)
  return (await res.json()) as RawResponse
}

const startRawTask = async (
  handler: { fetch: (req: Request) => Promise<Response> },
  prompt: string,
  extensions = true,
): Promise<RawResponse> =>
  rawCall(handler, "tools/call", { name: "banyan_task_start", arguments: { prompt } }, { extensions, name: "banyan_task_start" })

describe("tasks extension mapping (pure)", () => {
  test("engine states map onto extension states", () => {
    expect(toExtensionStatus("queued")).toBe("working")
    expect(toExtensionStatus("running")).toBe("working")
    expect(toExtensionStatus("needs_input")).toBe("input_required")
    expect(toExtensionStatus("done")).toBe("completed")
    expect(toExtensionStatus("failed")).toBe("failed")
    expect(toExtensionStatus("cancelled")).toBe("cancelled")
  })

  test("inputRequests are keyed by the pending request ID (D2 elicitation seam)", () => {
    const record = {
      pendingQuestion: { requestID: "req-1", kind: "question", title: "which file?", askedAt: 1 },
    } as TaskRecord
    const requests = buildInputRequests(record)
    expect(Object.keys(requests ?? {})).toEqual(["req-1"])
    expect(JSON.stringify(requests)).toContain("which file?")
    expect(buildInputRequests({} as TaskRecord)).toBeUndefined()
  })

  test("CreateTaskResult carries task identity, working status and polling hints", () => {
    const record = {
      handle: "btask_x",
      status: "running",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    } as TaskRecord
    const created = toCreateTaskResult(record)
    expect(created.resultType).toBe("task")
    expect(created.taskId).toBe("btask_x")
    expect(created.status).toBe("working")
    expect(created.ttlMs).toBe(TASK_TTL_MS)
    expect(created.pollIntervalMs).toBe(TASK_POLL_INTERVAL_MS)
    expect(typeof created.createdAt).toBe("string")
    expect(created.statusMessage).toBeUndefined()
    const queued = toCreateTaskResult({ ...record, status: "queued" })
    expect(queued.status).toBe("working")
    expect(typeof queued.statusMessage).toBe("string")
  })

  test("capability detection reads only the per-request envelope", () => {
    const withExt = {
      mcpReq: {
        envelope: {
          "io.modelcontextprotocol/clientCapabilities": { extensions: { [TasksExtensionID]: {} } },
        },
      },
    }
    expect(hasTasksExtension(withExt)).toBe(true)
    expect(hasTasksExtension({ mcpReq: { envelope: {} } })).toBe(false)
    expect(hasTasksExtension({ mcpReq: {} })).toBe(false)
    expect(hasTasksExtension(undefined)).toBe(false)
  })
})

describe("tasks extension fallback and gate (both eras)", () => {
  test("server advertises the tasks extension to modern clients", async () => {
    await withPlainBothEras(async (_fx, client) => {
      if (client.getProtocolEra() !== "modern") return
      const caps = client.getServerCapabilities() as Record<string, unknown> | undefined
      const extensions = (caps?.["extensions"] ?? {}) as Record<string, unknown>
      expect(TasksExtensionID in extensions).toBe(true)
    })
  })

  test("banyan_task_start without the extension returns the normal tool result", async () => {
    await withPlainBothEras(async (_fx, client) => {
      const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "do the thing" } })
      expect(isToolError(started)).toBe(false)
      const body = toolJson<{ task_id: string; status: string }>(started)
      assertHandleShape(body.task_id)
      expect(body.status).toBe("running")
      // No extension fields leak onto the fallback surface.
      const structured = (started as McpTextResult).structuredContent ?? {}
      expect("resultType" in structured).toBe(false)
      expect("taskId" in structured).toBe(false)
    })
  })

  test("tasks/* without the extension answers -32021", async () => {
    await withPlainBothEras(async (_fx, client) => {
      if (client.getProtocolEra() !== "legacy") return
      // Modern SDK clients refuse to SEND legacy tasks vocabulary at all;
      // the modern no-extension path is covered by raw fetch below.
      const error = await client
        .request({ method: "tasks/get", params: { taskId: "btask_nope" } }, loose)
        .then(() => undefined)
        .catch((e: unknown) => e as { code?: unknown; data?: unknown })
      expect(error?.code).toBe(-32021)
      const data = (error?.data ?? {}) as { requiredCapabilities?: { extensions?: Record<string, unknown> } }
      expect(TasksExtensionID in (data.requiredCapabilities?.extensions ?? {})).toBe(true)
    })
  })

  test("no tasks/list on either era", async () => {
    await withPlainBothEras(async (_fx, client) => {
      if (client.getProtocolEra() !== "legacy") return
      const error = await client
        .request({ method: "tasks/list", params: {} }, loose)
        .then(() => undefined)
        .catch((e: unknown) => e as { code?: unknown })
      expect(error?.code).toBe(-32601)
    })
  })
})

describe("tasks extension wire (modern raw fetch)", () => {
  const withRawServer = async (body: (fx: ExtFixtures, handler: { fetch: (req: Request) => Promise<Response> }) => Promise<unknown>): Promise<void> => {
    const fx = freshSetup()
    const mcp = buildExtServer(fx.deps)
    const handler = createMcpHandler(() => mcp)
    try {
      await body(fx, handler)
    } finally {
      fx.engine.close()
      await handler.close().catch(() => {})
    }
  }

  test("banyan_task_start returns CreateTaskResult only after durable creation", async () => {
    await withRawServer(async (fx, handler) => {
      const started = await startRawTask(handler, "do the thing")
      expect(started.error).toBeUndefined()
      const result = started.result ?? {}
      expect(result["resultType"]).toBe("task")
      expect(typeof result["taskId"]).toBe("string")
      assertHandleShape(result["taskId"] as string)
      expect(result["status"]).toBe("working")
      expect(result["ttlMs"]).toBe(TASK_TTL_MS)
      expect(result["pollIntervalMs"]).toBe(TASK_POLL_INTERVAL_MS)
      // Durably created: the engine record and its session exist, so a
      // tasks/get for the returned ID resolves on a capable transport.
      const record = fx.engine.get(result["taskId"] as string)
      expect(fx.fake.sessions.has(record.sessionID)).toBe(true)
    })
  })

  test("banyan_task_start without the extension stays on the fallback surface", async () => {
    await withRawServer(async (_fx, handler) => {
      const started = await startRawTask(handler, "do the thing", false)
      expect(started.error).toBeUndefined()
      expect(started.result?.["resultType"]).not.toBe("task")
    })
  })

  test("2025-vocabulary names are entry-blocked on SDK 2.2.0 (D3 signal)", async () => {
    // The SDK's modern entry answers -32601 for the removed 2025 method
    // names (tasks/get, tasks/cancel, tasks/list) before Server dispatch —
    // a truly unknown name (tasks/update, acme/*) falls through to our
    // handlers instead. The handlers below are protocol-reachable on
    // stdio/InMemory transports and fully covered by the direct-handler
    // suite plus the raw tasks/update flow; when the SDK (or the D3 HTTP
    // work) lifts the name gate this pin breaks and the raw tasks/get flow
    // becomes testable here.
    await withRawServer(async (_fx, handler) => {
      for (const method of ["tasks/get", "tasks/cancel", "tasks/list"] as const) {
        const params = method === "tasks/list" ? {} : { taskId: "btask_nope" }
        const name = method === "tasks/list" ? undefined : "btask_nope"
        const res = await rawCall(handler, method, params, name !== undefined ? { name } : {})
        expect(res.error?.code).toBe(-32601)
      }
      // tasks/update is NOT name-gated: unknown IDs answer -32602 from our
      // own handler (missing capability or unknown handle surface here).
      const unknown = await rawCall(
        handler,
        "tasks/update",
        { taskId: "btask_nope", inputResponses: {} },
        { name: "btask_nope" },
      )
      expect(unknown.error?.code).toBe(-32602)
    })
  })

  test("tasks/update answers input_required over the modern wire", async () => {
    // End-to-end through the real entry: params.inputResponses is lifted
    // to ctx by the SDK seam, and the values must arrive verbatim.
    await withRawServer(async (fx, handler) => {
      const started = await startRawTask(handler, "answer me")
      const taskId = started.result?.["taskId"] as string
      const sessionID = fx.engine.get(taskId).sessionID
      const pending = { requestID: "q-1", kind: "question", title: "which file?", askedAt: Date.now() } as const
      fx.fake.pendingBySession.set(sessionID, [{ ...pending }])
      fx.fake.emit({ type: "question.asked", sessionID, request: { ...pending } })
      await settleTo(fx, taskId, "needs_input", "running")

      const answered = await rawCall(
        handler,
        "tasks/update",
        { taskId, inputResponses: { "q-1": { decision: "approve", message: "src/widget.ts" } } },
        { name: taskId },
      )
      expect(answered.error).toBeUndefined()
      expect(answered.result?.["resultType"]).toBe("complete")
      expect(fx.fake.questionReplies.at(-1)).toEqual({ sessionID, message: "src/widget.ts" })
      await settleTo(fx, taskId, "running", "needs_input")
    })
  })
})

// Forged per-request envelope: the only way to exercise the handler units
// with the extension bit set, since SDK 2.2.0 clients cannot send tasks/*
// on modern or decode task results. The gate reads exactly this shape.
const extCtx = (): unknown => ({
  mcpReq: {
    envelope: {
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TasksExtensionID]: {} } },
    },
  },
})

const settleTo = async (
  fx: ExtFixtures,
  taskId: string,
  status: TaskRecord["status"],
  from: TaskRecord["status"],
): Promise<TaskRecord> => {
  const record = await fx.engine.waitForStateChange(taskId, { fromStatus: from, timeoutMs: 5000 })
  expect(record.status).toBe(status)
  return record
}

describe("tasks extension handlers (real engine, forged envelope)", () => {
  const withHandlers = async (
    body: (fx: ExtFixtures, handlers: ReturnType<typeof createTasksExtensionHandlers>) => Promise<unknown>,
  ): Promise<void> => {
    const fx = freshSetup()
    try {
      await body(fx, createTasksExtensionHandlers(fx.deps))
    } finally {
      fx.engine.close()
    }
  }

  test("get polls working, then completed with the compact result", async () => {
    await withHandlers(async (fx, handlers) => {
      const ctx = extCtx()
      const started = await fx.engine.start({ prompt: "do work", mcpClient: "test" })
      expect((await handlers.get({ taskId: started.handle }, ctx))["status"]).toBe("working")

      fx.fake.finish(started.sessionID, "all done")
      fx.fake.emit({ type: "session.idle", sessionID: started.sessionID })
      await settleTo(fx, started.handle, "done", "running")

      const completed = await handlers.get({ taskId: started.handle }, ctx)
      expect(completed["status"]).toBe("completed")
      expect(completed["resultType"]).toBe("complete")
      expect(completed["taskId"]).toBe(started.handle)
      const payload = completed["result"] as Record<string, unknown>
      const compact = payload["structuredContent"] as Record<string, unknown>
      expect(compact["task_id"]).toBe(started.handle)
      expect(JSON.stringify(payload)).not.toContain("ses_test_")

      // readDetailedTask agrees with the handler (broadcast uses it too).
      const viaHelper = await readDetailedTask(fx.deps, fx.engine.get(started.handle))
      expect(viaHelper["status"]).toBe("completed")

      // Terminal tasks acknowledge updates without changing state.
      expect((await handlers.update({ taskId: started.handle, inputResponses: {} }, ctx))["resultType"]).toBe(
        "complete",
      )
      expect((await handlers.get({ taskId: started.handle }, ctx))["status"]).toBe("completed")
    })
  })

  test("input_required carries inputRequests and update answers them", async () => {
    await withHandlers(async (fx, handlers) => {
      const ctx = extCtx()
      const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
      const pending = { requestID: "q-1", kind: "question", title: "which file?", askedAt: Date.now() } as const
      fx.fake.pendingBySession.set(started.sessionID, [{ ...pending }])
      fx.fake.emit({ type: "question.asked", sessionID: started.sessionID, request: { ...pending } })
      await settleTo(fx, started.handle, "needs_input", "running")

      const waiting = await handlers.get({ taskId: started.handle }, ctx)
      expect(waiting["status"]).toBe("input_required")
      expect(Object.keys((waiting["inputRequests"] ?? {}) as Record<string, unknown>)).toEqual(["q-1"])

      // Unknown keys are ignored per spec: the task stays input_required.
      const ignored = await handlers.update(
        { taskId: started.handle, inputResponses: { "wrong-key": { decision: "approve", message: "x" } } },
        ctx,
      )
      expect(ignored["resultType"]).toBe("complete")
      expect((await handlers.get({ taskId: started.handle }, ctx))["status"]).toBe("input_required")

      // The outstanding answer (D1 shape) resumes the task.
      const answered = await handlers.update(
        { taskId: started.handle, inputResponses: { "q-1": { decision: "approve", message: "src/widget.ts" } } },
        ctx,
      )
      expect(answered["resultType"]).toBe("complete")
      expect(fx.fake.questionReplies.at(-1)).toEqual({ sessionID: started.sessionID, message: "src/widget.ts" })
      await settleTo(fx, started.handle, "running", "needs_input")
      expect((await handlers.get({ taskId: started.handle }, ctx))["status"]).toBe("working")

      // MRTR elicitation results map onto the same reply.
      fx.fake.pendingBySession.set(started.sessionID, [
        { requestID: "q-2", kind: "question", title: "again?", askedAt: Date.now() },
      ])
      fx.fake.emit({
        type: "question.asked",
        sessionID: started.sessionID,
        request: { requestID: "q-2", kind: "question", title: "again?", askedAt: Date.now() },
      })
      await settleTo(fx, started.handle, "needs_input", "running")
      const elicited = await handlers.update(
        { taskId: started.handle, inputResponses: { "q-2": { action: "accept", content: "src/other.ts" } } },
        ctx,
      )
      expect(elicited["resultType"]).toBe("complete")
      expect(fx.fake.questionReplies.at(-1)).toEqual({ sessionID: started.sessionID, message: "src/other.ts" })
    })
  })

  test("reply mapping covers strings, decisions, actions and rejects garbage", () => {
    expect(replyFromInputResponses("plain answer", "r")).toEqual({ decision: "approve", message: "plain answer" })
    expect(replyFromInputResponses({ decision: "reject" }, "r")).toEqual({ decision: "reject" })
    expect(replyFromInputResponses({ decision: "approve", message: "yes" }, "r")).toEqual({
      decision: "approve",
      message: "yes",
    })
    expect(replyFromInputResponses({ action: "accept", content: { input: "x" } }, "r")).toEqual({
      decision: "approve",
      message: "x",
    })
    expect(replyFromInputResponses({ action: "decline" }, "r")).toEqual({ decision: "reject" })
    expect(replyFromInputResponses(undefined, "r")).toBeUndefined()
    expect(() => replyFromInputResponses({ nonsense: 1 }, "r")).toThrow()
    expect(() => replyFromInputResponses(42, "r")).toThrow()
  })

  test("failed maps with the error, cancel terminates", async () => {
    await withHandlers(async (fx, handlers) => {
      const ctx = extCtx()
      const doomed = await fx.engine.start({ prompt: "doomed", mcpClient: "test" })
      fx.fake.emit({ type: "session.error", sessionID: doomed.sessionID, message: "boom" })
      await settleTo(fx, doomed.handle, "failed", "running")
      const failed = await handlers.get({ taskId: doomed.handle }, ctx)
      expect(failed["status"]).toBe("failed")
      expect((failed["error"] as { message?: string })?.message).toContain("boom")

      const cancellable = await fx.engine.start({ prompt: "cancellable", mcpClient: "test" })
      const acked = await handlers.cancel({ taskId: cancellable.handle }, ctx)
      expect(acked["resultType"]).toBe("complete")
      expect((await handlers.get({ taskId: cancellable.handle }, ctx))["status"]).toBe("cancelled")

      // readDetailedTask covers the non-completed branches identically.
      expect((await readDetailedTask(fx.deps, fx.engine.get(cancellable.handle)))["status"]).toBe("cancelled")
      expect((await readDetailedTask(fx.deps, fx.engine.get(doomed.handle)))["status"]).toBe("failed")
    })
  })

  test("unknown handles are -32602 and missing capabilities are -32021", async () => {
    await withHandlers(async (fx, handlers) => {
      const ctx = extCtx()
      for (const call of [
        () => handlers.get({ taskId: "btask_nope" }, ctx),
        () => handlers.update({ taskId: "btask_nope", inputResponses: {} }, ctx),
        () => handlers.cancel({ taskId: "btask_nope" }, ctx),
      ]) {
        const error = await call().then(
          () => undefined,
          (e: unknown) => e as { code?: unknown },
        )
        expect(error?.code).toBe(-32602)
      }
      for (const call of [
        () => handlers.get({ taskId: "btask_nope" }, undefined),
        () => handlers.update({ taskId: "btask_nope", inputResponses: {} }, {}),
        () => handlers.cancel({ taskId: "btask_nope" }, {}),
      ]) {
        const error = await call().then(
          () => undefined,
          (e: unknown) => e as { code?: unknown; data?: unknown },
        )
        expect(error?.code).toBe(-32021)
        const data = (error?.data ?? {}) as { requiredCapabilities?: { extensions?: Record<string, unknown> } }
        expect(TasksExtensionID in (data.requiredCapabilities?.extensions ?? {})).toBe(true)
      }
    })
  })
})

describe("tasks extension notifications (legacy broadcast)", () => {
  test("notifications/tasks follows working to completed", async () => {
    // Modern leg is intentionally inert: SDK 2.2.0 serving entries own
    // subscriptions/listen streams and their filter drops taskIds, so
    // task notifications cannot ride them. The broadcast below covers the
    // stdio/InMemory path; modern clients poll tasks/get (covered above).
    for (const era of MCP_ERAS) {
      if (era !== "legacy") continue
      const fx = freshSetup()
      try {
        await withEraClient(era, () => buildExtServer(fx.deps), taskClientInfo, async (client) => {
          const seen: Array<Record<string, unknown>> = []
          client.setNotificationHandler("notifications/tasks", { params: loose }, (params) => {
            seen.push(params as Record<string, unknown>)
          })
          const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "do work" } })
          expect(isToolError(started)).toBe(false)
          const taskId = toolJson<{ task_id: string }>(started).task_id
          const sessionID = fx.engine.get(taskId).sessionID
          fx.fake.finish(sessionID, "all done")
          fx.fake.emit({ type: "session.idle", sessionID })
          let done: Record<string, unknown> | undefined
          for (let i = 0; i < 100; i++) {
            done = seen.find((n) => n["taskId"] === taskId && n["status"] === "completed")
            if (done) break
            await new Promise((r) => setTimeout(r, 50))
          }
          expect(seen.find((n) => n["taskId"] === taskId && n["status"] === "working")).toBeDefined()
          expect(done?.["taskId"]).toBe(taskId)
          expect((done?.["result"] as Record<string, unknown> | undefined)?.["structuredContent"]).toBeDefined()
        })
      } finally {
        fx.engine.close()
      }
    }
  })
})
