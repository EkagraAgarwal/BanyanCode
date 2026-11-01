import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import type { Storage } from "../../src/storage/index.js"
import type { SystemMonitor } from "../../src/system/monitor.js"
import {
  NAME_SYSTEM_STATUS,
  NAME_SYSTEMINFO,
  NAME_TOOL_SEARCH,
  buildSystemTools,
  makeSystemStatusTool,
  makeToolSearchTool,
  renderSystemInfo,
  renderSystemStatus,
  scoreMatch,
  tierFor,
} from "../../src/system/tools.js"

const monitor: SystemMonitor = {
  status: async () => ({
    cpuPercent: 42.5,
    memoryUsedBytes: 4 * 1024 * 1024 * 1024,
    memoryTotalBytes: 16 * 1024 * 1024 * 1024,
    gpuPercent: 10,
    vramUsedBytes: 1024 * 1024 * 1024,
    gpuTotalBytes: 8 * 1024 * 1024 * 1024,
    diskUsedBytes: 100 * 1024 * 1024 * 1024,
    diskTotalBytes: 500 * 1024 * 1024 * 1024,
    platform: "linux",
  }),
}

const toolContext = {
  sessionID: "session-1",
  agent: "build",
  messageID: "message-1",
  id: "call-1",
  progress: () => Effect.void,
} as unknown as Tool.Context

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect as Effect.Effect<A>)

describe("system tools", () => {
  test("v1 tool ids and descriptions are exact", async () => {
    const tools = buildSystemTools({
      ctx: { tool: { list: () => Effect.succeed([]) } } as unknown as Context,
      monitor,
      storage: {} as Storage.Interface,
    })
    expect(tools.map((tool) => tool.name)).toEqual([NAME_SYSTEM_STATUS, NAME_SYSTEMINFO, NAME_TOOL_SEARCH])
    expect(tools[0]!.description).toBe(
      "Get current system health: CPU usage, memory used/total, GPU usage (if available), and platform. Call proactively before resource-intensive operations like code indexing, embedding, or LLM queries to make informed decisions.",
    )
    expect(tools[1]!.description).toContain("# systeminfo")
    expect(tools[1]!.description).toContain("Use this tool when:")
    expect(tools[2]!.description).toContain("banyan_tool_search")
    expect(tools[2]!.description).toContain("hot / warm / cold")
    for (const tool of tools) expect(tool.options?.permission).toBe(tool.name)
  })

  test("system_status returns v1 fields and omits disk", async () => {
    const tool = makeSystemStatusTool(monitor)
    const result = await run(tool.execute({}, toolContext))
    expect(result.output).toEqual({
      cpuPercent: 42.5,
      memoryUsedBytes: 4 * 1024 * 1024 * 1024,
      memoryTotalBytes: 16 * 1024 * 1024 * 1024,
      gpuPercent: 10,
      vramUsedBytes: 1024 * 1024 * 1024,
      gpuTotalBytes: 8 * 1024 * 1024 * 1024,
      platform: "linux",
    })
    expect(result.content).toBe("CPU: 42.5%, Memory: 4096MB / 16384MB, Platform: linux")
    expect(String(result.content)).toBe(renderSystemStatus(result.output!))
  })

  test("systeminfo renders human-readable memory and GPU", async () => {
    const status = await monitor.status()
    expect(renderSystemInfo(status)).toContain("Memory: 4.0 / 16.0 GB")
    expect(renderSystemInfo(status)).toContain("VRAM: 1.0/8.0 GB")
  })

  test("tool search scoring and tier assignment match v1", () => {
    expect(scoreMatch("verify", "verify")).toBe(4)
    expect(scoreMatch("verify", "verify-tools")).toBe(3)
    expect(scoreMatch("verify", "my-verify-tool")).toBe(2)
    expect(scoreMatch("verify", "other")).toBe(1)
    expect(tierFor("banyan_test", new Set(["banyan_test"]))).toBe("hot")
    expect(tierFor("codegraph_query", new Set())).toBe("cold")
    expect(tierFor("websearch", new Set())).toBe("warm")
  })

  test("banyan_tool_search ranks registered tools and reports diagnostics", async () => {
    const registered = [
      { id: "banyan_test", description: "Run tests", input: undefined },
      { id: "codegraph_query", description: "Query the graph", input: undefined },
      { id: "websearch", description: "Search the web", input: undefined },
    ]
    const asserted: string[] = []
    const ctx = {
      tool: { list: () => Effect.succeed(registered) },
      permission: {
        assert: (input: { action: string }) =>
          Effect.sync(() => {
            asserted.push(input.action)
          }),
      },
    } as unknown as Context
    const storage = {
      query: () => Effect.succeed([{ tool_id: "banyan_test" }]),
    } as unknown as Storage.Interface
    const tool = makeToolSearchTool({ ctx, storage, now: () => 1_000_000 })

    const hit = await run(tool.execute({ query: "test" }, toolContext))
    expect(asserted).toEqual([NAME_TOOL_SEARCH])
    expect(hit.output?.hits[0]?.tool.id).toBe("banyan_test")
    expect(hit.output?.hits[0]?.tool.tier).toBe("hot")
    expect(hit.output?.total).toBeGreaterThan(0)

    const empty = await run(tool.execute({ query: "   " }, toolContext))
    expect(empty.output?._diagnostic).toBe("empty-query")
    const none = await run(tool.execute({ query: "zzzz", tier: "cold" }, toolContext))
    expect(none.output?._diagnostic).toBe("no-matches")
  })
})
