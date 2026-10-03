// Stateless Streamable HTTP transport acceptance (gap-plan D3).
//
// Served over REAL HTTP (node:http listener + fetch): 401 without a token,
// 403 on a foreign Origin, 400/-32020 on Mcp-Method/Mcp-Name header mismatch,
// and two requests on different connections sharing one task_id through the
// REAL TaskEngine (same in-memory harness shape as tools-task.test.ts —
// scaffolding for the port, not a mock of production logic).
//
// The per-request factory builds a fresh McpServer per call (the documented
// stateless idiom: invoke() connects each product to its own per-request
// transport, so sharing one instance across concurrent requests would race).
// State crosses connections only via the shared engine's task handles.

import { describe, expect, test } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { MODERN_PROTOCOL_VERSION } from "./era-harness"
import { TaskEngine } from "../../src/mcp-server/task-engine"
import type {
  EngineEvent,
  EngineSessionClient,
  EngineSessionLookup,
  PendingQuestion,
} from "../../src/mcp-server/task-engine"
import { registerTaskTools } from "../../src/mcp-server/tools-task"
import type { TaskToolsConfig, TaskToolsDeps } from "../../src/mcp-server/tools-task"
import { assertHandleShape } from "../../src/mcp-server/task-handle"
import type { SessionClient, SessionMessage } from "../../src/mcp-server/types"
import type { DiffFileInput } from "../../src/mcp-server/result"
import {
  assertHttpBindAllowed,
  checkBearerAuth,
  createHttpFetchHandler,
  isLoopbackHost,
  listenHttp,
  resolveHttpToken,
} from "../../src/mcp-server/transport-http"

// --- same harness shape as tools-task.test.ts --------------------------------

class FakeSessions implements EngineSessionClient {
  sessions = new Map<
    string,
    { prompts: string[]; busy: boolean; assistant: string[]; metadata: Record<string, string>; title?: string }
  >()
  pendingBySession = new Map<string, PendingQuestion[]>()
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
    void input
  }

  async rejectQuestion(input: { sessionID: string; requestID: string }) {
    void input
  }

  async replyQuestion(input: { sessionID: string; requestID: string; message: string }) {
    void input
  }

  async writeMetadata(input: { sessionID: string; metadata: Record<string, string> }) {
    Object.assign(this.sessions.get(input.sessionID)!.metadata, input.metadata)
  }
}

const taskConfig = (): TaskToolsConfig => ({
  permission: "reject",
  allowYolo: false,
  resultMaxTokens: 1500,
  outputChars: 8000,
})

// --- policy unit tests (no sockets) ------------------------------------------

describe("http bind policy", () => {
  test("loopback hosts pass with no credentials", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true)
      expect(() =>
        assertHttpBindAllowed({ hostname: host, hostnameExplicit: false, tokenExplicit: false }),
      ).not.toThrow()
    }
    expect(isLoopbackHost("example.com")).toBe(false)
    expect(isLoopbackHost("192.168.1.10")).toBe(false)
  })

  test("non-loopback bind is refused without explicit hostname AND token", () => {
    expect(() =>
      assertHttpBindAllowed({ hostname: "0.0.0.0", hostnameExplicit: true, tokenExplicit: false }),
    ).toThrow(/refusing non-loopback/)
    expect(() =>
      assertHttpBindAllowed({ hostname: "0.0.0.0", hostnameExplicit: false, tokenExplicit: true }),
    ).toThrow(/refusing non-loopback/)
    expect(() =>
      assertHttpBindAllowed({ hostname: "0.0.0.0", hostnameExplicit: true, tokenExplicit: true }),
    ).not.toThrow()
  })

  test("token resolution prefers flag, then env, then generates", () => {
    expect(resolveHttpToken({ flag: "abc", env: {} })).toEqual({ token: "abc", explicit: true })
    expect(resolveHttpToken({ flag: "", env: { BANYANCODE_MCP_TOKEN: "env-token" } })).toEqual({
      token: "env-token",
      explicit: true,
    })
    const generated = resolveHttpToken({ env: {} })
    expect(generated.explicit).toBe(false)
    expect(generated.token.length).toBeGreaterThan(16)
    expect(resolveHttpToken({ env: {} }).token).not.toBe(resolveHttpToken({ env: {} }).token)
  })

  test("bearer gate: 401 without/wrong token, pass with the token", () => {
    expect(checkBearerAuth(undefined, "secret")?.status).toBe(401)
    expect(checkBearerAuth("Basic abc", "secret")?.status).toBe(401)
    expect(checkBearerAuth("Bearer wrong", "secret")?.status).toBe(401)
    expect(checkBearerAuth("Bearer secret", "secret")).toBeUndefined()
  })
})

// --- HTTP gate tests ----------------------------------------------------------

const TOKEN = "test-bearer-token"

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "transport-http-test", version: "0.0.0-test" },
}

async function postRaw(
  url: string,
  body: unknown,
  init?: { token?: string; origin?: string; headers?: Record<string, string> },
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(init?.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}),
    ...(init?.origin !== undefined ? { origin: init.origin } : {}),
    ...init?.headers,
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { _raw: text.slice(0, 200) }
  }
  return { status: res.status, json }
}

const rpcErrorCode = (json: unknown): number | undefined => {
  const r = json as { error?: { code?: unknown } }
  return typeof r.error?.code === "number" ? r.error.code : undefined
}

describe("http security gates over real HTTP", () => {
  test("401 without a token, 403 on a foreign Origin", async () => {
    const gated = createHttpFetchHandler(() => new McpServer({ name: "t", version: "0" }), { token: TOKEN })
    const listener = await listenHttp(gated.fetch, { hostname: "127.0.0.1" })
    try {
      const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_META } }
      const noToken = await postRaw(listener.url, body)
      expect(noToken.status).toBe(401)

      const wrongToken = await postRaw(listener.url, body, { token: "wrong" })
      expect(wrongToken.status).toBe(401)

      const foreignOrigin = await postRaw(listener.url, body, {
        token: TOKEN,
        origin: "https://evil.example",
      })
      expect(foreignOrigin.status).toBe(403)

      // Missing Origin (non-browser client) passes the gate — the request
      // reaches the handler (400 here only because the probe server has no
      // tools/list handler path worth asserting; the point is "not 403").
      const noOrigin = await postRaw(listener.url, body, { token: TOKEN })
      expect(noOrigin.status).not.toBe(401)
      expect(noOrigin.status).not.toBe(403)
    } finally {
      await gated.close().catch(() => {})
      await listener.close()
    }
  })

  test("400/-32020 on Mcp-Method header mismatch", async () => {
    const gated = createHttpFetchHandler(() => new McpServer({ name: "t", version: "0" }), { token: TOKEN })
    const listener = await listenHttp(gated.fetch, { hostname: "127.0.0.1" })
    try {
      const body = { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: MODERN_META } }
      // Present-but-wrong Mcp-Method disagrees with the body method.
      const mismatched = await postRaw(listener.url, body, {
        token: TOKEN,
        headers: { "mcp-method": "tools/call", "mcp-protocol-version": MODERN_PROTOCOL_VERSION },
      })
      expect(mismatched.status).toBe(400)
      expect(rpcErrorCode(mismatched.json)).toBe(-32020)

      // Missing standard headers on a modern request is also a mismatch.
      const missing = await postRaw(listener.url, body, { token: TOKEN })
      expect(missing.status).toBe(400)
      expect(rpcErrorCode(missing.json)).toBe(-32020)
    } finally {
      await gated.close().catch(() => {})
      await listener.close()
    }
  })
})

// --- cross-connection task handle via the real engine -------------------------

async function connectModern(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client(
    { name: "transport-http-test-client", version: "0.0.0-test" },
    { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
  )
  await client.connect(transport)
  return client
}

const toolJson = <T>(result: unknown): T =>
  JSON.parse((result as { content: Array<{ text: string }> }).content[0]?.text ?? "null") as T

describe("stateless task sharing across connections", () => {
  test("two requests on different connections share one task_id", async () => {
    const fake = new FakeSessions()
    const engine = new TaskEngine(fake, fake.store, fake.events, { maxConcurrentTasks: 4 })
    const deps: TaskToolsDeps = {
      engine,
      sessions: fake as unknown as SessionClient,
      directory: "/repo",
      updateMetadata: (input) => fake.writeMetadata(input),
      getMcpClientName: () => "transport-http-test-client",
      config: taskConfig(),
    }
    // Fresh server per request (stateless idiom), one shared engine.
    const gated = createHttpFetchHandler(() => {
      const mcp = new McpServer({ name: "banyancode-test", version: "0.0.0-test" })
      registerTaskTools(mcp, deps)
      return mcp
    }, { token: TOKEN })
    const listener = await listenHttp(gated.fetch, { hostname: "127.0.0.1" })
    try {
      // Connection 1: start a task, then go away entirely.
      const first = await connectModern(listener.url, TOKEN)
      const started = await first.callTool({ name: "banyan_task_start", arguments: { prompt: "do the thing" } })
      const startBody = toolJson<{ task_id: string; status: string }>(started)
      assertHandleShape(startBody.task_id)
      // No session affinity: the handle is opaque, never the raw ses_ id.
      expect(startBody.task_id).not.toContain("ses_")
      await first.close().catch(() => {})

      // Connection 2 (fresh client, fresh server instance server-side):
      // the same handle resolves through the shared engine.
      const second = await connectModern(listener.url, TOKEN)
      try {
        const status = await second.callTool({
          name: "banyan_task_status",
          arguments: { task_id: startBody.task_id },
        })
        expect(toolJson<{ task_id: string; status: string }>(status).status).toBe("running")
        const cancelled = await second.callTool({
          name: "banyan_task_cancel",
          arguments: { task_id: startBody.task_id },
        })
        expect(toolJson<{ task_id: string; status: string }>(cancelled).status).toBe("cancelled")
      } finally {
        await second.close().catch(() => {})
      }
    } finally {
      engine.close()
      await gated.close().catch(() => {})
      await listener.close()
    }
  })
})

export * as McpTransportHttpTest from "./transport-http.test"
