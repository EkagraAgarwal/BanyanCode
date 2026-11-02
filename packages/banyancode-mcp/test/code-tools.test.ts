// Protocol-level test for the code tools: a real MCP client over linked
// in-memory transports, a real McpServer, and a fake RPC port that implements
// the server-side `banyancode.*` method names (the definitions themselves are
// the real ones from `@banyancode/plugin/rpc/*`).

import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { createMcpServer } from "../src/server"
import { TaskEngine } from "../src/engine"
import { resolveConfig } from "../src/config"
import { createFakePort } from "./fake-port"
import { createFakeRpc, type FakeRpc } from "./fake-rpc"

const cwd = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-code-"))

type Rig = {
  client: Client
  rpc: FakeRpc
  engine: TaskEngine
  close: () => Promise<void>
}

const rig = async (options: { outputMaxChars?: number; toolGroups?: string[] } = {}): Promise<Rig> => {
  const port = createFakePort()
  const config = resolveConfig({ cwd, configPath: path.join(cwd, "missing.json"), env: {} })
  const rpc = createFakeRpc()
  const engine = new TaskEngine({ port, config, root: cwd, sweepIntervalMs: 60_000 })
  const bootstrap = createMcpServer({
    engine,
    config: { ...config, ...(options.outputMaxChars !== undefined ? { outputMaxChars: options.outputMaxChars } : {}) },
    root: cwd,
    rpc: rpc.caller,
    ...(options.toolGroups !== undefined ? { toolGroups: options.toolGroups } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await bootstrap.mcp.connect(serverTransport)
  const client = new Client({ name: "code-test-harness", version: "1.0.0" })
  await client.connect(clientTransport)
  return {
    client,
    rpc,
    engine,
    close: async () => {
      await client.close().catch(() => undefined)
      await bootstrap.close().catch(() => undefined)
      engine.close()
    },
  }
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>

const structured = (result: CallToolResult): Record<string, unknown> => {
  const value = result.structuredContent
  if (value === null || typeof value !== "object") throw new Error("expected structuredContent")
  return value as Record<string, unknown>
}

const text = (result: CallToolResult): string => {
  const first = result.content[0]
  return first !== undefined && "text" in first && first.text !== undefined ? first.text : ""
}

describe("MCP code tools", () => {
  const rigs: Rig[] = []
  afterEach(async () => {
    await Promise.all(rigs.splice(0).map((item) => item.close()))
  })

  test("advertises the five v1 code tools with bounded, untrusted output schemas", async () => {
    const r = await rig()
    rigs.push(r)
    const tools = await r.client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    for (const name of ["banyan_codegraph", "banyan_code_find", "banyan_repo", "banyan_change_check", "banyan_verify"]) {
      expect(names).toContain(name)
    }
    expect(names).not.toContain("banyan_memory")
    for (const tool of tools.tools.filter((tool) => tool.name.startsWith("banyan_") && tool.name !== "banyan_memory")) {
      if (["banyan_checkup", "banyan_kill", "banyan_task_cancel", "banyan_task_list", "banyan_task_reply", "banyan_task_result", "banyan_task_spawn", "banyan_task_start", "banyan_task_status"].includes(tool.name)) continue
      expect(tool.description).toContain("untrusted")
      const properties = (tool.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
      expect(properties?.["untrusted"]).toBeDefined()
    }
  }, 15_000)

  test("tool groups gate the code tools and no memory tool exists", async () => {
    const codeOnly = await rig({ toolGroups: ["code"] })
    rigs.push(codeOnly)
    const codeNames = (await codeOnly.client.listTools()).tools.map((tool) => tool.name)
    expect(codeNames).toContain("banyan_verify")
    expect(codeNames).not.toContain("banyan_task_start")

    const taskOnly = await rig({ toolGroups: ["task"] })
    rigs.push(taskOnly)
    const taskNames = (await taskOnly.client.listTools()).tools.map((tool) => tool.name)
    expect(taskNames).toContain("banyan_task_start")
    expect(taskNames).not.toContain("banyan_code_find")

    // The tool must not exist at the protocol level: the client rejects the
    // call before it reaches the server.
    let memoryError: unknown
    try {
      await codeOnly.client.callTool({ name: "banyan_memory", arguments: {} })
    } catch (error) {
      memoryError = error
    }
    expect(String(memoryError)).toContain("banyan_memory")
    expect(String(memoryError)).toContain("not found")
  })

  test("banyan_code_find forwards v1 parameters and defaults keyword fallback", async () => {
    const r = await rig()
    rigs.push(r)
    r.rpc.on("banyancode.intel.codeFind", () => ({ matches: [{ path: "src/a.ts", node: { name: "foo" } }] }))
    const response = await r.client.callTool({
      name: "banyan_code_find",
      arguments: { intent: "definition", target: "foo" },
    })
    expect(response.isError).toBeFalsy()
    expect(r.rpc.calls).toHaveLength(1)
    expect(r.rpc.calls[0]).toEqual({
      rpcID: "banyancode.intel",
      method: "codeFind",
      input: { intent: "definition", target: "foo", includeKeywordFallback: true },
    })
    expect(structured(response)["untrusted"]).toBe(true)
    expect(structured(response)["result"]).toEqual({ matches: [{ path: "src/a.ts", node: { name: "foo" } }] })
  })

  test("banyan_code_find clamps large code bodies and truncates oversized payloads", async () => {
    const r = await rig({ outputMaxChars: 1_200 })
    rigs.push(r)
    r.rpc.on("banyancode.intel.codeFind", () => ({
      matches: Array.from({ length: 60 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        node: { name: `symbol_${index}`, code: "const x = 1\n".repeat(400) },
      })),
    }))
    const response = await r.client.callTool({
      name: "banyan_code_find",
      arguments: { intent: "definition", target: "symbol", limit: 60 },
    })
    expect(response.isError).toBeFalsy()
    const body = structured(response)
    expect(body["truncated"]).toBe(true)
    expect((body["omitted"] as number)).toBeGreaterThan(0)
    const rendered = text(response)
    expect(rendered.length).toBeLessThanOrEqual(2_400)
    expect(rendered).not.toContain("const x = 1\nconst x = 1\nconst x = 1\nconst x = 1\n")
  })

  test("banyan_repo validates per-op arguments and guards paths", async () => {
    const r = await rig()
    rigs.push(r)
    const missing = await r.client.callTool({ name: "banyan_repo", arguments: { op: "query" } })
    expect(missing.isError).toBe(true)
    expect(text(missing).startsWith("INVALID_ARGUMENTS")).toBe(true)

    const escape = await r.client.callTool({
      name: "banyan_repo",
      arguments: { op: "impact", path: "../outside.ts" },
    })
    expect(escape.isError).toBe(true)
    expect(text(escape).startsWith("PATH_ESCAPE")).toBe(true)
    expect(r.rpc.calls).toHaveLength(0)

    r.rpc.on("banyancode.intel.impact", (input) => ({ input }))
    const impact = await r.client.callTool({
      name: "banyan_repo",
      arguments: { op: "impact", path: "src/a.ts" },
    })
    expect(impact.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.input).toEqual({ path: path.join(cwd, "src", "a.ts") })
  })

  test("banyan_repo dispatches every v1 op to its intel method", async () => {
    const r = await rig()
    rigs.push(r)
    const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
      [{ op: "query", query: "auth" }, "query", { query: "auth" }],
      [{ op: "explain", symbol: "Foo" }, "explain", { symbol: "Foo" }],
      [{ op: "trace", symbol: "Foo", depth: 2 }, "trace", { symbol: "Foo", depth: 2 }],
      [{ op: "tests", symbol: "Foo" }, "tests", { symbol: "Foo" }],
      [{ op: "symbols", query: "bar", limit: 5 }, "symbols", { query: "bar", limit: 5 }],
      [{ op: "relationships", nodeID: "n1", depth: 3 }, "relationships", { nodeID: "n1", depth: 3 }],
      [{ op: "slice", focus: "Foo" }, "slice", { focus: "Foo" }],
    ]
    for (const [args, method, expected] of cases) {
      const response = await r.client.callTool({ name: "banyan_repo", arguments: args })
      expect(response.isError).toBeFalsy()
      const call = r.rpc.calls.at(-1)
      expect(call?.method).toBe(method)
      expect(call?.input).toEqual(expected)
    }
  })

  test("banyan_change_check defaults preflight action to modify and forwards blast radius depth", async () => {
    const r = await rig()
    rigs.push(r)
    const preflight = await r.client.callTool({
      name: "banyan_change_check",
      arguments: { op: "preflight", target: "Foo" },
    })
    expect(preflight.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.method).toBe("preflight")
    expect(r.rpc.calls.at(-1)?.input).toEqual({ target: "Foo", action: "modify" })

    const blast = await r.client.callTool({
      name: "banyan_change_check",
      arguments: { op: "blast_radius", target: "Foo", depth: 3 },
    })
    expect(blast.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.method).toBe("blastRadius")
    expect(r.rpc.calls.at(-1)?.input).toEqual({ target: "Foo", maxDepth: 3 })
  })

  test("banyan_codegraph resolves the root and selects status, build and staleness", async () => {
    const r = await rig()
    rigs.push(r)
    const status = await r.client.callTool({ name: "banyan_codegraph", arguments: { op: "status" } })
    expect(status.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.method).toBe("status")
    expect(r.rpc.calls.at(-1)?.input).toEqual({ root: path.resolve(cwd) })

    const build = await r.client.callTool({
      name: "banyan_codegraph",
      arguments: { op: "build", force: true },
    })
    expect(build.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.method).toBe("build")
    expect(r.rpc.calls.at(-1)?.input).toEqual({ root: path.resolve(cwd), force: true })

    const staleness = await r.client.callTool({ name: "banyan_codegraph", arguments: { op: "staleness" } })
    expect(staleness.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.method).toBe("staleness")
  })

  test("banyan_verify requires a path for tests and summarizes counts, not logs", async () => {
    const r = await rig()
    rigs.push(r)
    const missing = await r.client.callTool({ name: "banyan_verify", arguments: { kind: "test" } })
    expect(missing.isError).toBe(true)
    expect(text(missing).startsWith("INVALID_ARGUMENTS")).toBe(true)

    r.rpc.on("banyancode.verify.test", () => ({
      status: "failed",
      summary: { passed: 3, failed: 1, skipped: 0 },
      durationMs: 12.4,
      cacheHit: false,
      rawOutput: "fail 1\nfail 2\nfail 3\n",
    }))
    const tested = await r.client.callTool({
      name: "banyan_verify",
      arguments: { kind: "test", path: "src/a.test.ts", max_failures: 2 },
    })
    expect(tested.isError).toBeFalsy()
    const call = r.rpc.calls.at(-1)
    expect(call?.rpcID).toBe("banyancode.verify")
    expect(call?.method).toBe("test")
    expect((call?.input as Record<string, unknown>)["path"]).toBe("src/a.test.ts")
    expect((call?.input as Record<string, unknown>)["projectRoot"]).toBe(path.resolve(cwd))
    const envelope = structured(tested)
    expect(envelope["untrusted"]).toBe(true)
    const body = envelope["result"] as Record<string, unknown>
    expect(body["kind"]).toBe("test")
    expect(body["passed"]).toBe(3)
    expect(body["failed"]).toBe(1)
    expect(body["failures"]).toEqual(["fail 1", "fail 2"])
    expect(body["command"]).toBe("bun test src/a.test.ts")
  })

  test("banyan_verify typecheck and lint reach the verify namespace", async () => {
    const r = await rig()
    rigs.push(r)
    r.rpc.on("banyancode.verify.typecheck", () => ({
      status: "passed",
      summary: { passed: 0, failed: 0, skipped: 0 },
      durationMs: 1,
      cacheHit: true,
    }))
    const typecheck = await r.client.callTool({ name: "banyan_verify", arguments: { kind: "typecheck" } })
    expect(typecheck.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.method).toBe("typecheck")
    expect((r.rpc.calls.at(-1)?.input as Record<string, unknown>)["projectRoot"]).toBe(path.resolve(cwd))

    r.rpc.on("banyancode.verify.lint", () => ({
      status: "errored",
      summary: {},
      durationMs: 3,
      cacheHit: false,
      command: "bun run lint",
    }))
    const lint = await r.client.callTool({ name: "banyan_verify", arguments: { kind: "lint" } })
    expect(lint.isError).toBeFalsy()
    expect(r.rpc.calls.at(-1)?.method).toBe("lint")
    expect((structured(lint)["result"] as Record<string, unknown>)["lintCommand"]).toBe("bun run lint")
  })

  test("a server without the BanyanCode plugin reports RPC_UNAVAILABLE, never a crash", async () => {
    const r = await rig()
    rigs.push(r)
    r.rpc.on("banyancode.intel.codeFind", () => {
      throw { type: "rpc.method_not_found", message: "no such method" }
    })
    const response = await r.client.callTool({
      name: "banyan_code_find",
      arguments: { intent: "definition", target: "Foo" },
    })
    expect(response.isError).toBe(true)
    expect(text(response).startsWith("RPC_UNAVAILABLE")).toBe(true)
    expect(text(response)).toContain("BanyanCode plugin")
  })
})

describe("RPC failure detail", () => {
  const rigs: Rig[] = []
  afterEach(async () => {
    await Promise.all(rigs.splice(0).map((item) => item.close()))
  })

  test("a generic RPC call failure includes the underlying message", async () => {
    const r = await rig()
    rigs.push(r)
    r.rpc.on("banyancode.intel.codeFind", () => {
      throw {
        type: "rpc.internal",
        message: "RPC call failed",
        data: { message: "unknown session ses_nope" },
      }
    })
    const response = await r.client.callTool({
      name: "banyan_code_find",
      arguments: { intent: "definition", target: "Foo" },
    })
    expect(response.isError).toBe(true)
    expect(text(response)).toContain("unknown session ses_nope")
  })
})
