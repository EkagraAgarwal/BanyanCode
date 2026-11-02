import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { cli, fakeServer, rpcOutput, tmpRoot } from "./fixture"

const report = {
  eventCount: 4,
  runCount: 1,
  agentCount: 2,
  modelCallCount: 2,
  toolCallCount: 2,
  inputTokens: 120,
  cachedInputTokens: 20,
  uncachedInputTokens: 100,
  outputTokens: 30,
  totalCost: 0.25,
  realizedCacheReadRatio: 0.1666,
  byRole: {
    coder: {
      events: 2,
      inputTokens: 60,
      outputTokens: 15,
      cost: 0.1,
      cachedInputTokens: 10,
      uncachedInputTokens: 50,
    },
  },
}

describe("telemetry status/on/off", () => {
  test("reads and writes the global banyancode.json like v1", async () => {
    const root = await tmpRoot("banyancode-cli-telemetry-")
    const config = path.join(root, "xdg-config", "banyancode", "banyancode.json")

    const initial = await cli(root, ["telemetry", "status"])
    expect(initial.exitCode).toBe(0)
    expect(initial.stderr).toContain("Telemetry: enabled")
    expect(initial.stderr).toContain("install_id: (none — first run pending)")
    expect(initial.stderr).toContain("banyancode_telemetry = on (default)")

    const off = await cli(root, ["telemetry", "off"])
    expect(off.stderr).toContain("Telemetry disabled")
    const written = JSON.parse(await fs.readFile(config, "utf8"))
    expect(written).toEqual({
      $schema: "https://banyan.dev/schema/banyancode.json",
      banyancode_telemetry: "off",
    })

    const disabled = await cli(root, ["telemetry", "status"])
    expect(disabled.stderr).toContain("Telemetry: disabled")
    expect(disabled.stderr).toContain("re-enable with: banyancode telemetry on")

    const envOff = await cli(root, ["telemetry", "status"], { env: { DO_NOT_TRACK: "1" } })
    expect(envOff.stderr).toContain("Telemetry: disabled")

    const on = await cli(root, ["telemetry", "on"])
    expect(on.stderr).toContain("Telemetry enabled")
    expect(JSON.parse(await fs.readFile(config, "utf8")).banyancode_telemetry).toBe("on")
  }, 180_000)

  test("prints the install id recorded by the plugin", async () => {
    const root = await tmpRoot("banyancode-cli-telemetry-id-")
    const state = path.join(root, "state", "banyancode")
    await fs.mkdir(state, { recursive: true })
    await fs.writeFile(path.join(state, "install.json"), JSON.stringify({ install_id: "abc-123", telemetry: {} }))
    const result = await cli(root, ["telemetry", "status"])
    expect(result.stderr).toContain("install_id: abc-123")
  }, 120_000)
})

describe("telemetry agent-report / agent-export", () => {
  test("renders the report and exports JSONL through banyancode.usage", async () => {
    const root = await tmpRoot("banyancode-cli-agent-report-")
    const seen: Array<{ rpcID: string; method: string; input: unknown }> = []
    const server = fakeServer(async (request, url) => {
      const match = /^\/api\/rpc\/([^/]+)\/(.+)$/.exec(url.pathname)
      if (!match) return undefined
      const body = (await request.json()) as { input?: unknown }
      seen.push({ rpcID: match[1] ?? "", method: match[2] ?? "", input: body.input })
      if (match[2] === "telemetry.agentReport") return rpcOutput(report)
      if (match[2] === "telemetry.agentExport")
        return rpcOutput({
          jsonl: '{"eventID":"e1"}\n{"eventID":"e2"}\n',
          count: 2,
          events: [{ eventID: "e1" }, { eventID: "e2" }],
        })
      return undefined
    })
    try {
      const text = await cli(root, [
        "telemetry",
        "agent-report",
        "--run-id",
        "run_1",
        "--session-id",
        "ses_1",
        "--since",
        "5",
        "--server",
        server.url,
      ])
      expect(text.exitCode).toBe(0)
      expect(text.stderr).toContain("Agent telemetry")
      expect(text.stderr).toContain("events: 4")
      expect(text.stderr).toContain("realized cache-read ratio: 0.1666")
      expect(text.stderr).toContain("coder: 2 events, 60 input, 15 output")

      const json = await cli(root, ["telemetry", "agent-report", "--json", "--server", server.url])
      expect(json.exitCode).toBe(0)
      expect(JSON.parse(json.stdout)).toEqual(report)

      const exported = await cli(root, ["telemetry", "agent-export", "--server", server.url])
      expect(exported.exitCode).toBe(0)
      expect(exported.stdout.trim().split("\n")).toEqual(['{"eventID":"e1"}', '{"eventID":"e2"}'])

      // The config diagnostic probe runs first; assert on the command's own call.
      expect(seen.find((entry) => entry.method === "telemetry.agentReport")).toEqual({
        rpcID: "banyancode.usage",
        method: "telemetry.agentReport",
        input: { runID: "run_1", sessionID: "ses_1", since: 5 },
      })
    } finally {
      server.stop()
    }
  }, 180_000)

  test("surfaces a missing plugin namespace", async () => {
    const root = await tmpRoot("banyancode-cli-agent-missing-")
    const server = fakeServer(() =>
      Response.json({ type: "rpc.method_not_found", message: "no such method" }, { status: 404 }),
    )
    try {
      const result = await cli(root, ["telemetry", "agent-report", "--server", server.url])
      expect(result.exitCode).toBe(1)
      expect(result.stderr.trim().length).toBeGreaterThan(0)
    } finally {
      server.stop()
    }
  }, 180_000)
})
