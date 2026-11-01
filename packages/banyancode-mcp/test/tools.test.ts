// Protocol-level test: a real MCP client over linked in-memory transports
// against a real McpServer, a real TaskEngine and the fake session port. This
// is where the tool schemas, output schemas, instructions and resources are
// exercised exactly as a harness (Claude Code, Codex, Cursor) would see them.

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { createMcpServer, SERVER_INSTRUCTIONS } from "../src/server"
import { TaskEngine } from "../src/engine"
import { resolveConfig, type ResolvedConfig } from "../src/config"
import { createFakePort, event, type FakePort } from "./fake-port"
import { createFakeRpc } from "./fake-rpc"

const cwd = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-protocol-"))

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => {
  const base = resolveConfig({ cwd, configPath: path.join(cwd, "missing.json"), env: {} })
  return { ...base, ...overrides, autonomy: { ...base.autonomy, ...(overrides.autonomy ?? {}) } }
}

type Rig = {
  client: Client
  engine: TaskEngine
  port: FakePort
  bootstrap: ReturnType<typeof createMcpServer>
  close: () => Promise<void>
}

const rig = async (overrides: Partial<ResolvedConfig> = {}): Promise<Rig> => {
  const port = createFakePort({ projects: [{ id: "prj_1", canonical: cwd }] })
  const engine = new TaskEngine({ port, config: config(overrides), root: cwd, sweepIntervalMs: 60_000 })
  const bootstrap = createMcpServer({ engine, config: config(overrides), root: cwd, rpc: createFakeRpc().caller })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await bootstrap.mcp.connect(serverTransport)
  const client = new Client(
    { name: "test-harness", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  )
  await client.connect(clientTransport)
  return {
    client,
    engine,
    port,
    bootstrap,
    close: async () => {
      await client.close().catch(() => undefined)
      await bootstrap.close().catch(() => undefined)
      engine.close()
    },
  }
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>

const resourceText = (content: { text?: string; blob?: string } | undefined): string =>
  content !== undefined && "text" in content && content.text !== undefined ? content.text : ""

const structured = (result: CallToolResult): Record<string, unknown> => {
  const value = result.structuredContent
  if (value === null || typeof value !== "object") throw new Error("expected structuredContent")
  return value as Record<string, unknown>
}

describe("MCP task tools", () => {
  const rigs: Rig[] = []
  afterEach(async () => {
    await Promise.all(rigs.splice(0).map((item) => item.close()))
  })

  test("advertises the task + code tool set and the checkup-loop instructions", async () => {
    const r = await rig()
    rigs.push(r)
    const tools = await r.client.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    expect(names).toEqual(
      [
        "banyan_change_check",
        "banyan_checkup",
        "banyan_code_find",
        "banyan_codegraph",
        "banyan_kill",
        "banyan_repo",
        "banyan_verify",
        "banyan_task_cancel",
        "banyan_task_list",
        "banyan_task_reply",
        "banyan_task_result",
        "banyan_task_spawn",
        "banyan_task_start",
        "banyan_task_status",
      ].sort(),
    )
    for (const tool of tools.tools) expect(tool.outputSchema).toBeDefined()
    const instructions = r.client.getInstructions()
    expect(instructions).toBe(SERVER_INSTRUCTIONS)
    expect(instructions).toContain("banyan_checkup")
    expect(instructions).toContain("cursor")
    expect(instructions).toContain("banyan_verify")
    expect(instructions).not.toContain("banyan_memory")
  }, 15_000)

  test("start → checkup → status → result → list → cancel", async () => {
    const r = await rig()
    rigs.push(r)
    const started = await r.client.callTool({
      name: "banyan_task_start",
      arguments: { prompt: "add a test", agent: "coder" },
    })
    expect(started.isError).toBeFalsy()
    const startBody = structured(started)
    const taskID = startBody["task_id"] as string
    expect(taskID.startsWith("btask_")).toBe(true)
    expect(startBody["status"]).toBe("running")

    const session = r.port.sessions.get(r.engine.get(taskID).sessionID)!
    session.log = [
      event(1, "session.step.started"),
      event(2, "session.tool.called", { name: "edit", input: { filePath: "src/a.ts" } }),
      event(3, "session.step.ended", { cost: 0.01, tokens: { input: 10, output: 5 }, files: ["src/a.ts"] }),
      event(4, "session.text.ended", { text: "added the test" }),
    ]

    const checkup = await r.client.callTool({ name: "banyan_checkup", arguments: {} })
    expect(checkup.isError).toBeFalsy()
    const report = structured(checkup)
    const task = (report["tasks"] as Array<Record<string, unknown>>)[0]!
    expect(task["task_id"]).toBe(taskID)
    expect((task["progress"] as Record<string, unknown>)["steps"]).toBe(1)
    expect((task["progress"] as Record<string, unknown>)["last_text"]).toBe("added the test")
    expect(typeof report["cursor"]).toBe("string")

    const second = await r.client.callTool({
      name: "banyan_checkup",
      arguments: { cursor: report["cursor"] },
    })
    const secondTask = (structured(second)["tasks"] as Array<Record<string, unknown>>)[0]!
    expect((secondTask["progress"] as Record<string, unknown>)["steps"]).toBe(0)

    const status = await r.client.callTool({ name: "banyan_task_status", arguments: { task_id: taskID } })
    expect(structured(status)["status"]).toBe("running")
    expect(structured(status)["files_changed"]).toBe(1)

    const result = await r.client.callTool({ name: "banyan_task_result", arguments: { task_id: taskID } })
    const summary = structured(result)["summary"] as Record<string, unknown>
    expect(summary["steps"]).toBe(1)
    expect(summary["last_text"]).toBe("added the test")

    const list = await r.client.callTool({ name: "banyan_task_list", arguments: {} })
    expect((structured(list)["tasks"] as unknown[]).length).toBe(1)

    const cancelled = await r.client.callTool({ name: "banyan_task_cancel", arguments: { task_id: taskID } })
    expect((structured(cancelled)["cancelled"] as Array<Record<string, unknown>>)[0]?.["status"]).toBe("cancelled")
  }, 15_000)

  test("unknown handles return the coded UNKNOWN_TASK error", async () => {
    const r = await rig()
    rigs.push(r)
    const result = await r.client.callTool({
      name: "banyan_task_status",
      arguments: { task_id: "btask_" + "0".repeat(64) },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? ""
    expect(text).toContain("UNKNOWN_TASK")
  }, 15_000)

  test("spawn creates child tasks and the list is a tree", async () => {
    const r = await rig()
    rigs.push(r)
    const parent = structured(
      await r.client.callTool({ name: "banyan_task_start", arguments: { prompt: "parent" } }),
    )["task_id"] as string
    const spawned = await r.client.callTool({
      name: "banyan_task_spawn",
      arguments: { task_id: parent, subtasks: [{ prompt: "child one" }, { prompt: "child two" }] },
    })
    expect(spawned.isError).toBeFalsy()
    expect((structured(spawned)["tasks"] as unknown[]).length).toBe(2)
    const tree = structured(await r.client.callTool({ name: "banyan_task_list", arguments: {} }))
    const roots = tree["tasks"] as Array<Record<string, unknown>>
    expect(roots).toHaveLength(1)
    expect((roots[0]?.["children"] as unknown[]).length).toBe(2)
  }, 15_000)

  test("kill switch: banyan_kill cancels everything and BANYANCODE_MCP_KILL gates calls", async () => {
    const r = await rig()
    rigs.push(r)
    await r.client.callTool({ name: "banyan_task_start", arguments: { prompt: "one" } })
    await r.client.callTool({ name: "banyan_task_start", arguments: { prompt: "two" } })
    const killed = await r.client.callTool({ name: "banyan_kill", arguments: {} })
    expect(structured(killed)["killed"]).toBe(2)

    process.env["BANYANCODE_MCP_KILL"] = "1"
    try {
      const blocked = await r.client.callTool({ name: "banyan_task_start", arguments: { prompt: "three" } })
      expect(blocked.isError).toBe(true)
      expect((blocked.content as Array<{ text?: string }>)[0]?.text).toContain("MCP_KILLED")
    } finally {
      delete process.env["BANYANCODE_MCP_KILL"]
    }
  }, 15_000)
})

describe("MCP resources", () => {
  const rigs: Rig[] = []
  afterEach(async () => {
    await Promise.all(rigs.splice(0).map((item) => item.close()))
  })

  test("banyan://tasks and banyan://task/{id} are readable and track state", async () => {
    const r = await rig()
    rigs.push(r)
    const resources = await r.client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toContain("banyan://tasks")

    const taskID = structured(
      await r.client.callTool({ name: "banyan_task_start", arguments: { prompt: "resource task" } }),
    )["task_id"] as string

    const listRead = await r.client.readResource({ uri: "banyan://tasks" })
    const listBody = JSON.parse(String(resourceText(listRead.contents[0]))) as { tasks: Array<Record<string, unknown>> }
    expect(listBody.tasks[0]?.["task_id"]).toBe(taskID)

    const detailRead = await r.client.readResource({ uri: `banyan://task/${taskID}` })
    const detailBody = JSON.parse(String(resourceText(detailRead.contents[0]))) as Record<string, unknown>
    expect(detailBody["task_id"]).toBe(taskID)
    expect(detailBody["status"]).toBe("running")

    const missing = await r.client.readResource({ uri: "banyan://task/btask_unknown" })
    expect(String(resourceText(missing.contents[0]))).toContain("UNKNOWN_TASK")
  }, 15_000)

  test("capabilities advertise subscribable resources and transitions push updates", async () => {
    const r = await rig()
    rigs.push(r)
    expect(r.client.getServerCapabilities()?.resources).toEqual({ subscribe: true, listChanged: true })
    const notifications: Array<{ method: string; params?: { uri?: string } }> = []
    r.bootstrap.mcp.server.notification = (async (notification: { method: string; params?: { uri?: string } }) => {
      notifications.push(notification)
    }) as typeof r.bootstrap.mcp.server.notification
    const taskID = structured(
      await r.client.callTool({ name: "banyan_task_start", arguments: { prompt: "subscribe" } }),
    )["task_id"] as string
    await r.client.callTool({ name: "banyan_task_cancel", arguments: { task_id: taskID } })
    await Bun.sleep(20)
    const updated = notifications.filter((item) => item.method === "notifications/resources/updated")
    expect(updated.some((item) => item.params?.uri === "banyan://tasks")).toBe(true)
    expect(updated.some((item) => item.params?.uri === `banyan://task/${taskID}`)).toBe(true)
  }, 15_000)

  test("v1 isolation: worktree allocates a real checkout, permission must match the policy", async () => {
    const r = await rig({ permission: "reject" })
    rigs.push(r)
    const rejected = await r.client.callTool({
      name: "banyan_task_start",
      arguments: { prompt: "edit files", permission: "edits" },
    })
    expect(rejected.isError).toBe(true)
    expect(resourceText(rejected.content[0] as { text?: string })).toContain("does not match the server policy")

    const started = await r.client.callTool({
      name: "banyan_task_start",
      arguments: { prompt: "edit files", isolation: "worktree", permission: "reject", wait_seconds: 0 },
    })
    expect(started.isError).toBeFalsy()
    expect(structured(started)["isolation"]).toBe("worktree")
    expect(r.port.calls.createWorktree).toHaveLength(1)
    expect(r.port.calls.createWorktree[0]?.projectID).toBe("prj_1")

    const shared = await r.client.callTool({
      name: "banyan_task_start",
      arguments: { prompt: "read only", isolation: "shared" },
    })
    expect(shared.isError).toBeFalsy()
    expect(structured(shared)["isolation"]).toBe("shared")
    expect(r.port.calls.createWorktree).toHaveLength(1)
  }, 15_000)
})
