// Streamable HTTP transport: bearer gate, per-request servers over one shared
// engine, and a real MCP client over the wire.

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { createMcpServer } from "../src/server"
import { TaskEngine } from "../src/engine"
import { resolveConfig } from "../src/config"
import { startHttp, type HttpHandle } from "../src/transport-http"
import { createFakePort } from "./fake-port"
import { createFakeRpc } from "./fake-rpc"

const cwd = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-http-"))
const TOKEN = "test-token"

const rig = async (): Promise<{ http: HttpHandle; engine: TaskEngine; close: () => Promise<void> }> => {
  const config = resolveConfig({ cwd, configPath: path.join(cwd, "missing.json"), env: {} })
  const port = createFakePort()
  const engine = new TaskEngine({ port, config, root: cwd, sweepIntervalMs: 60_000 })
  const http = await startHttp({
    create: () =>
      createMcpServer({ engine, config, root: cwd, rpc: createFakeRpc().caller, watchTransitions: false }).mcp,
    port: 0,
    token: TOKEN,
  })
  return {
    http,
    engine,
    close: async () => {
      await http.close()
      engine.close()
    },
  }
}

const unauthorized = async (url: string): Promise<number> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  })
  await response.body?.cancel()
  return response.status
}

describe("Streamable HTTP transport", () => {
  const handles: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((close) => close()))
  })

  test("rejects requests without a bearer token", async () => {
    const r = await rig()
    handles.push(r.close)
    expect(await unauthorized(r.http.url)).toBe(401)
  }, 15_000)

  test("serves a real MCP client over HTTP with per-request servers over one engine", async () => {
    const r = await rig()
    handles.push(r.close)
    const transport = new StreamableHTTPClientTransport(new URL(r.http.url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    })
    const client = new Client({ name: "http-harness", version: "1.0.0" })
    await client.connect(transport)
    try {
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toContain("banyan_checkup")
      const started = await client.callTool({ name: "banyan_task_start", arguments: { prompt: "http task" } })
      expect(started.isError).toBeFalsy()
      const taskID = (started.structuredContent as { task_id: string }).task_id
      // A second request reuses the SAME engine through a DIFFERENT server
      // instance: the handle must still resolve.
      const status = await client.callTool({ name: "banyan_task_status", arguments: { task_id: taskID } })
      expect((status.structuredContent as { task_id: string }).task_id).toBe(taskID)
      expect(r.engine.has(taskID)).toBe(true)
    } finally {
      await client.close().catch(() => undefined)
    }
  }, 30_000)

  test("a non-loopback bind needs an explicit hostname and token", async () => {
    const config = resolveConfig({ cwd, configPath: path.join(cwd, "missing.json"), env: {} })
    const port = createFakePort()
    const engine = new TaskEngine({ port, config, root: cwd })
    await expect(
      startHttp({
        create: () => createMcpServer({ engine, config, root: cwd, rpc: createFakeRpc().caller }).mcp,
        hostname: "0.0.0.0",
      }),
    ).rejects.toThrow(/refusing non-loopback bind/)
    engine.close()
  }, 15_000)
})
