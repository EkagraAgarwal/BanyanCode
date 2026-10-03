// MRTR elicitation flow (gap-plan Milestone D2, SEP-2322).
//
// Tasks path: needs_input tasks carry a real `elicitation/create` form in
// inputRequests plus a sealed requestState; tasks/update validates the
// echoed state before routing the answer to engine.reply. Tool path:
// banyan_task_status / banyan_task_reply return InputRequiredResult with
// inputRequests + requestState when the client declared elicitation, and
// the normal payload otherwise. Sampling and roots are never sent.

import { describe, expect, test } from "bun:test"
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  createMcpHandler,
} from "@modelcontextprotocol/server"
import { MODERN_PROTOCOL_VERSION } from "./era-harness"
import { TaskEngine } from "../../src/mcp-server/task-engine"
import type {
  EngineEvent,
  EngineSessionClient,
  EngineSessionLookup,
  PendingQuestion,
  TaskRecord,
} from "../../src/mcp-server/task-engine"
import { registerTaskTools } from "../../src/mcp-server/tools-task"
import type { TaskToolsDeps } from "../../src/mcp-server/tools-task"
import {
  TasksExtensionID,
  answerRequestedSchema,
  buildInputRequests,
  clientSupportsElicitation,
  createTasksExtensionHandlers,
  readClientCapabilities,
  readDetailedTask,
  toToolInputRequired,
} from "../../src/mcp-server/tools-task"
import { createRequestStateService } from "../../src/mcp-server/request-state"
import type { RequestStateService } from "../../src/mcp-server/request-state"
import type { SessionClient, SessionMessage } from "../../src/mcp-server/types"
import type { DiffFileInput } from "../../src/mcp-server/result"

const SECRET = Buffer.alloc(32, 7)

// Same in-memory harness shape as the D1 suites: one store implementing
// both the engine lifecycle port and the tasks-port reader. replyQuestion
// can leave a follow-up pending to simulate a question chain.
class FakeSessions implements EngineSessionClient {
  sessions = new Map<
    string,
    { prompts: string[]; busy: boolean; assistant: string[]; metadata: Record<string, string> }
  >()
  pendingBySession = new Map<string, PendingQuestion[]>()
  questionReplies: Array<{ sessionID: string; message: string }> = []
  questionRejects: string[] = []
  leaveFollowUpOnReply = false
  next = 1
  listeners: Array<(event: EngineEvent) => void> = []
  // Injectable clock so askedAt timestamps stay on the engine's clock
  // (a real-Date askedAt against a frozen engine clock makes the
  // needs_input timer overflow 32 bits).
  now: () => number = Date.now

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

  async createSession(input: { title?: string; metadata: Record<string, string> }) {
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

  async prompt(input: { sessionID: string; prompt: string }) {
    await this.promptAsync(input)
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

  async toolParts(input: { sessionID: string }) {
    void input.sessionID
    return []
  }

  async replyPermission(input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }) {
    void input.reply
    void input.requestID
    this.pendingBySession.set(input.sessionID, [])
  }

  async rejectQuestion(input: { sessionID: string; requestID: string }) {
    this.questionRejects.push(input.requestID)
    this.pendingBySession.set(input.sessionID, [])
  }

  async replyQuestion(input: { sessionID: string; requestID: string; message: string }) {
    this.questionReplies.push({ sessionID: input.sessionID, message: input.message })
    if (this.leaveFollowUpOnReply) {
      this.pendingBySession.set(input.sessionID, [
        { requestID: "q-2", kind: "question", title: "and then?", askedAt: this.now() },
      ])
    } else {
      this.pendingBySession.set(input.sessionID, [])
    }
    this.sessions.get(input.sessionID)!.busy = true
  }

  async writeMetadata(input: { sessionID: string; metadata: Record<string, string> }) {
    Object.assign(this.sessions.get(input.sessionID)!.metadata, input.metadata)
  }
}

type Fx = { fake: FakeSessions; engine: TaskEngine; deps: TaskToolsDeps; clock: { at: number } }

const freshSetup = (opts?: { followUp?: boolean; ttlMs?: number }): Fx => {
  const fake = new FakeSessions()
  if (opts?.followUp) fake.leaveFollowUpOnReply = true
  const clock = { at: 1_700_000_000_000 }
  fake.now = () => clock.at
  const requestState: RequestStateService = createRequestStateService({
    secret: SECRET,
    now: () => clock.at,
    ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  })
  const engine = new TaskEngine(fake, fake.store, fake.events, { maxConcurrentTasks: 4, now: () => clock.at })
  const deps: TaskToolsDeps = {
    engine,
    sessions: fake as unknown as SessionClient,
    directory: "/repo",
    updateMetadata: (input) => fake.writeMetadata(input),
    getMcpClientName: () => "test-client",
    requestState,
    config: { permission: "reject", allowYolo: false, resultMaxTokens: 1500, outputChars: 8000 },
  }
  return { fake, engine, deps, clock }
}

const extCtx = (): unknown => ({
  mcpReq: {
    envelope: {
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TasksExtensionID]: {} } },
    },
  },
})

const elicitationCtx = (): unknown => ({
  mcpReq: {
    envelope: {
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TasksExtensionID]: {} }, elicitation: {} },
    },
  },
})

const settleTo = async (fx: Fx, taskId: string, status: TaskRecord["status"], from: TaskRecord["status"]) => {
  const record = await fx.engine.waitForStateChange(taskId, { fromStatus: from, timeoutMs: 5000 })
  expect(record.status).toBe(status)
  return record
}

const askQuestion = async (fx: Fx, taskId: string, requestID: string, title = "which file?") => {
  const sessionID = fx.engine.get(taskId).sessionID
  const pending: PendingQuestion = { requestID, kind: "question", title, detail: "pick one", askedAt: fx.clock.at }
  fx.fake.pendingBySession.set(sessionID, [pending])
  fx.fake.emit({ type: "question.asked", sessionID, request: { ...pending } })
  await settleTo(fx, taskId, "needs_input", "running")
  return sessionID
}

describe("elicitation form requests", () => {
  test("buildInputRequests emits a real elicitation/create form keyed by request ID", () => {
    const record = {
      pendingQuestion: { requestID: "req-1", kind: "question", title: "which file?", detail: "pick one", askedAt: 1 },
    } as TaskRecord
    const requests = buildInputRequests(record)
    expect(Object.keys(requests ?? {})).toEqual(["req-1"])
    const entry = (requests as Record<string, Record<string, unknown>>)["req-1"]
    expect(entry?.["method"]).toBe("elicitation/create")
    const params = entry?.["params"] as Record<string, unknown>
    expect(params?.["message"]).toContain("which file?")
    expect(params?.["message"]).toContain("pick one")
    const schema = params?.["requestedSchema"] as Record<string, unknown>
    expect(schema?.["type"]).toBe("object")
    expect((schema?.["required"] as string[]) ?? []).toEqual(["decision"])
    expect(buildInputRequests({} as TaskRecord)).toBeUndefined()
  })

  test("answerRequestedSchema mirrors the reply decision contract", () => {
    const schema = answerRequestedSchema()
    const decision = (schema["properties"] as Record<string, Record<string, unknown>>)["decision"]
    expect(decision?.["enum"]).toEqual(["approve", "reject"])
    expect(schema["required"]).toEqual(["decision"])
  })

  test("no sampling or roots requests are ever constructed", () => {
    const record = {
      pendingQuestion: { requestID: "req-1", kind: "permission", title: "write src/a.ts", askedAt: 1 },
    } as TaskRecord
    const wire = JSON.stringify({ requests: buildInputRequests(record), schema: answerRequestedSchema() })
    expect(wire).not.toContain("sampling")
    expect(wire).not.toContain("roots")
  })
})

describe("elicitation capability detection", () => {
  test("bare and form declarations count; url-only, sampling-only and absent do not", () => {
    const caps = (elicitation: unknown): unknown => ({
      mcpReq: { envelope: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation } } },
    })
    expect(clientSupportsElicitation(caps({}))).toBe(true)
    expect(clientSupportsElicitation(caps({ form: {} }))).toBe(true)
    expect(clientSupportsElicitation(caps({ form: {}, url: {} }))).toBe(true)
    expect(clientSupportsElicitation(caps({ url: {} }))).toBe(false)
    expect(clientSupportsElicitation({ mcpReq: { envelope: { [CLIENT_CAPABILITIES_META_KEY]: { sampling: {} } } } })).toBe(
      false,
    )
    expect(clientSupportsElicitation({ mcpReq: { envelope: {} } })).toBe(false)
    expect(clientSupportsElicitation({ mcpReq: {} })).toBe(false)
    expect(clientSupportsElicitation(undefined)).toBe(false)
    expect(clientSupportsElicitation(extCtx())).toBe(false)
    expect(clientSupportsElicitation(elicitationCtx())).toBe(true)
  })

  test("readClientCapabilities returns the envelope caps only", () => {
    expect(readClientCapabilities(elicitationCtx())).toMatchObject({ elicitation: {} })
    expect(readClientCapabilities(undefined)).toBeUndefined()
  })
})

describe("tasks path requestState", () => {
  const withFx = async (body: (fx: Fx) => Promise<unknown>, opts?: { followUp?: boolean; ttlMs?: number }) => {
    const fx = freshSetup(opts)
    try {
      await body(fx)
    } finally {
      fx.engine.close()
    }
  }

  test("input_required carries inputRequests plus a verifiable requestState", async () => {
    await withFx(async (fx) => {
      const handlers = createTasksExtensionHandlers(fx.deps)
      const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
      await askQuestion(fx, started.handle, "q-1")
      const waiting = await handlers.get({ taskId: started.handle }, extCtx())
      expect(waiting["status"]).toBe("input_required")
      expect(Object.keys((waiting["inputRequests"] ?? {}) as Record<string, unknown>)).toEqual(["q-1"])
      const state = waiting["requestState"]
      expect(typeof state).toBe("string")
      const payload = fx.deps.requestState!.verify(state, {
        principal: "test-client",
        taskHandle: started.handle,
        requestID: "q-1",
      })
      expect(payload.taskHandle).toBe(started.handle)
    })
  })

  test("valid requestState plus D1 answer is applied", async () => {
    await withFx(async (fx) => {
      const handlers = createTasksExtensionHandlers(fx.deps)
      const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
      const sessionID = await askQuestion(fx, started.handle, "q-1")
      const state = (await handlers.get({ taskId: started.handle }, extCtx()))["requestState"] as string
      const answered = await handlers.update(
        { taskId: started.handle, inputResponses: { "q-1": { decision: "approve", message: "src/a.ts" } }, requestState: state },
        extCtx(),
      )
      expect(answered["resultType"]).toBe("complete")
      expect(fx.fake.questionReplies.at(-1)).toEqual({ sessionID, message: "src/a.ts" })
      await settleTo(fx, started.handle, "running", "needs_input")
    })
  })

  test("valid requestState plus MRTR accept/content is applied", async () => {
    await withFx(async (fx) => {
      const handlers = createTasksExtensionHandlers(fx.deps)
      const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
      const sessionID = await askQuestion(fx, started.handle, "q-1")
      const state = (await handlers.get({ taskId: started.handle }, extCtx()))["requestState"] as string
      await handlers.update(
        { taskId: started.handle, inputResponses: { "q-1": { action: "accept", content: "src/b.ts" } }, requestState: state },
        extCtx(),
      )
      expect(fx.fake.questionReplies.at(-1)).toEqual({ sessionID, message: "src/b.ts" })
    })
  })

  test("legacy answers without requestState still apply", async () => {
    await withFx(async (fx) => {
      const handlers = createTasksExtensionHandlers(fx.deps)
      const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
      const sessionID = await askQuestion(fx, started.handle, "q-1")
      await handlers.update(
        { taskId: started.handle, inputResponses: { "q-1": { decision: "approve", message: "src/a.ts" } } },
        extCtx(),
      )
      expect(fx.fake.questionReplies.at(-1)).toEqual({ sessionID, message: "src/a.ts" })
    })
  })

  test("tampered requestState is rejected and the task stays input_required", async () => {
    await withFx(async (fx) => {
      const handlers = createTasksExtensionHandlers(fx.deps)
      const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
      await askQuestion(fx, started.handle, "q-1")
      const state = (await handlers.get({ taskId: started.handle }, extCtx()))["requestState"] as string
      const tampered = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A")
      const error = await handlers
        .update(
          { taskId: started.handle, inputResponses: { "q-1": { decision: "approve", message: "x" } }, requestState: tampered },
          extCtx(),
        )
        .then(() => undefined, (e: unknown) => e as { code?: unknown })
      expect(error?.code).toBe(-32602)
      expect(fx.fake.questionReplies).toEqual([])
      expect((await handlers.get({ taskId: started.handle }, extCtx()))["status"]).toBe("input_required")
    })
  })

  test("expired requestState is rejected", async () => {
    await withFx(
      async (fx) => {
        const handlers = createTasksExtensionHandlers(fx.deps)
        const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
        await askQuestion(fx, started.handle, "q-1")
        const state = (await handlers.get({ taskId: started.handle }, extCtx()))["requestState"] as string
        fx.clock.at += 2_000
        const error = await handlers
          .update(
            { taskId: started.handle, inputResponses: { "q-1": { decision: "approve", message: "x" } }, requestState: state },
            extCtx(),
          )
          .then(() => undefined, (e: unknown) => e as { code?: unknown })
        expect(error?.code).toBe(-32602)
        expect(fx.fake.questionReplies).toEqual([])
      },
      { ttlMs: 1_000 },
    )
  })

  test("replayed requestState is rejected on second use", async () => {
    await withFx(async (fx) => {
      const handlers = createTasksExtensionHandlers(fx.deps)
      const started = await fx.engine.start({ prompt: "answer me", mcpClient: "test" })
      await askQuestion(fx, started.handle, "q-1")
      const state = (await handlers.get({ taskId: started.handle }, extCtx()))["requestState"] as string
      await handlers.update(
        { taskId: started.handle, inputResponses: { "q-1": { decision: "approve", message: "first" } }, requestState: state },
        extCtx(),
      )
      expect(fx.fake.questionReplies).toHaveLength(1)
      // Same request ID asks again; the redeemed token must not answer twice.
      await askQuestion(fx, started.handle, "q-1")
      const error = await handlers
        .update(
          { taskId: started.handle, inputResponses: { "q-1": { decision: "approve", message: "second" } }, requestState: state },
          extCtx(),
        )
        .then(() => undefined, (e: unknown) => e as { code?: unknown })
      expect(error?.code).toBe(-32602)
      expect(fx.fake.questionReplies).toHaveLength(1)
    })
  })

  test("requestState minted for another task is rejected", async () => {
    await withFx(async (fx) => {
      const handlers = createTasksExtensionHandlers(fx.deps)
      const first = await fx.engine.start({ prompt: "first", mcpClient: "test" })
      const second = await fx.engine.start({ prompt: "second", mcpClient: "test" })
      await askQuestion(fx, first.handle, "q-1")
      await askQuestion(fx, second.handle, "q-1")
      const foreign = (await handlers.get({ taskId: first.handle }, extCtx()))["requestState"] as string
      const error = await handlers
        .update(
          { taskId: second.handle, inputResponses: { "q-1": { decision: "approve", message: "x" } }, requestState: foreign },
          extCtx(),
        )
        .then(() => undefined, (e: unknown) => e as { code?: unknown })
      expect(error?.code).toBe(-32602)
      expect(fx.fake.questionReplies).toEqual([])
    })
  })
})

describe("tool path InputRequiredResult (modern raw fetch)", () => {
  type RawResponse = { result?: Record<string, unknown>; error?: { code: number; message: string } }

  const rawCall = async (
    handler: { fetch: (req: Request) => Promise<Response> },
    method: string,
    params: Record<string, unknown>,
    caps: Record<string, unknown>,
    name?: string,
  ): Promise<RawResponse> => {
    const req = new Request("http://test.local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        "mcp-method": method,
        ...(name !== undefined ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1_000_000_000),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "mrtr-test-client", version: "0.0.0-test" },
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { [TasksExtensionID]: {} },
              ...caps,
            },
          },
        },
      }),
    })
    const res = await handler.fetch(req)
    return (await res.json()) as RawResponse
  }

  const toolCall = (
    handler: { fetch: (req: Request) => Promise<Response> },
    name: string,
    args: Record<string, unknown>,
    caps: Record<string, unknown>,
  ): Promise<RawResponse> => rawCall(handler, "tools/call", { name, arguments: args }, caps, name)

  const withRawServer = async (body: (fx: Fx, handler: { fetch: (req: Request) => Promise<Response> }) => Promise<unknown>): Promise<void> => {
    const fx = freshSetup()
    const mcp = new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
    registerTaskTools(mcp, fx.deps)
    const handler = createMcpHandler(() => mcp)
    try {
      await body(fx, handler)
    } finally {
      fx.engine.close()
      await handler.close().catch(() => {})
    }
  }

  const startTask = async (handler: { fetch: (req: Request) => Promise<Response> }, prompt: string): Promise<string> => {
    const started = await toolCall(handler, "banyan_task_start", { prompt }, {})
    expect(started.error).toBeUndefined()
    return started.result?.["taskId"] as string
  }

  test("banyan_task_status returns input_required with requestState when elicitation is declared", async () => {
    await withRawServer(async (fx, handler) => {
      const taskId = await startTask(handler, "answer me")
      await askQuestion(fx, taskId, "q-1")
      const status = await toolCall(handler, "banyan_task_status", { task_id: taskId }, { elicitation: {} })
      expect(status.error).toBeUndefined()
      expect(status.result?.["resultType"]).toBe("input_required")
      expect(Object.keys((status.result?.["inputRequests"] ?? {}) as Record<string, unknown>)).toEqual(["q-1"])
      const state = status.result?.["requestState"]
      expect(typeof state).toBe("string")
      expect(
        fx.deps.requestState!.verify(state, { principal: "test-client", taskHandle: taskId, requestID: "q-1" })
          .requestID,
      ).toBe("q-1")
      expect(JSON.stringify(status.result)).not.toContain("sampling")
      expect(JSON.stringify(status.result)).not.toContain("roots")
    })
  })

  test("banyan_task_status falls back to the status view without elicitation", async () => {
    await withRawServer(async (fx, handler) => {
      const taskId = await startTask(handler, "answer me")
      await askQuestion(fx, taskId, "q-1")
      const status = await toolCall(handler, "banyan_task_status", { task_id: taskId }, {})
      expect(status.error).toBeUndefined()
      expect(status.result?.["resultType"]).not.toBe("input_required")
      const structured = (status.result?.["structuredContent"] ?? {}) as Record<string, unknown>
      const view = (structured["result"] ?? {}) as Record<string, unknown>
      expect(view["status"]).toBe("needs_input")
      expect((view["pendingQuestion"] as Record<string, unknown>)?.["title"]).toContain("which file?")
    })
  })

  test("banyan_task_reply returns input_required when a follow-up question is pending", async () => {
    const fx = freshSetup({ followUp: true })
    const mcp = new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
    registerTaskTools(mcp, fx.deps)
    const handler = createMcpHandler(() => mcp)
    try {
      const started = await toolCall(handler, "banyan_task_start", { prompt: "answer me" }, { elicitation: {} })
      const taskId = started.result?.["taskId"] as string
      await askQuestion(fx, taskId, "q-1")
      const replied = await toolCall(
        handler,
        "banyan_task_reply",
        { task_id: taskId, decision: "approve", message: "src/a.ts" },
        { elicitation: {} },
      )
      expect(replied.error).toBeUndefined()
      expect(replied.result?.["resultType"]).toBe("input_required")
      expect(Object.keys((replied.result?.["inputRequests"] ?? {}) as Record<string, unknown>)).toEqual(["q-2"])
    } finally {
      fx.engine.close()
      await handler.close().catch(() => {})
    }
  })

  test("banyan_task_reply returns the status view when nothing is pending", async () => {
    await withRawServer(async (fx, handler) => {
      const taskId = await startTask(handler, "answer me")
      await askQuestion(fx, taskId, "q-1")
      const replied = await toolCall(
        handler,
        "banyan_task_reply",
        { task_id: taskId, decision: "approve", message: "src/a.ts" },
        { elicitation: {} },
      )
      expect(replied.error).toBeUndefined()
      expect(replied.result?.["resultType"]).not.toBe("input_required")
    })
  })
})

describe("toToolInputRequired unit", () => {
  test("undefined without a pending question; sealed payload with one", () => {
    const fx = freshSetup()
    try {
      expect(toToolInputRequired(fx.deps, { status: "running" } as TaskRecord)).toBeUndefined()
      const record = {
        handle: "btask_x",
        status: "needs_input",
        pendingQuestion: { requestID: "q-1", kind: "question", title: "t", askedAt: 1 },
      } as TaskRecord
      const required = toToolInputRequired(fx.deps, record)
      expect(required?.resultType).toBe("input_required")
      expect(Object.keys(required?.inputRequests ?? {})).toEqual(["q-1"])
      expect(
        fx.deps.requestState!.verify(required!.requestState, {
          principal: "test-client",
          taskHandle: "btask_x",
          requestID: "q-1",
        }).principal,
      ).toBe("test-client")
    } finally {
      fx.engine.close()
    }
  })
})
