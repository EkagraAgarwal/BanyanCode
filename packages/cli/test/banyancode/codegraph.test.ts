import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { cli, fakeServer, plain, rpcOutput, startServer, tinyProject, tmpRoot, type RunningServer } from "./fixture"

let root: string
let project: string
let server: RunningServer

beforeAll(async () => {
  root = await tmpRoot("banyancode-cli-codegraph-")
  project = await tinyProject(root)
  server = await startServer(root)
}, 180_000)

afterAll(async () => {
  await server?.stop()
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
})

describe("codegraph commands against a real server", () => {
  test("path prints the plugin database path", async () => {
    const result = await cli(root, ["codegraph", "path", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr.trim()).toMatch(/projects[\\/]banyancode-[0-9a-f]{12}.*\.db$/)
    expect(result.stderr.trim()).toStartWith(root)
  }, 120_000)

  test("status prints v1's progress line", async () => {
    const result = await cli(root, ["codegraph", "status", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toMatch(/^\[[█░]{20}\] \d+\/\d+  (idle|running|completed|failed|cancelled)/)
  }, 120_000)

  test("cancel reports an idle graph instead of failing", async () => {
    const result = await cli(root, ["codegraph", "cancel", "--server", server.url])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("no build is currently running")
  }, 120_000)

  // Not exercised against a real server: on Windows the plugin's force-kill
  // escalates to an elevated `taskkill /F /PID <server>` — it would kill the
  // server this file is testing against (and prompt for UAC). The RPC shape is
  // covered with a fake server instead.
  test("force-kill prints the plugin's verdict", async () => {
    const fake = fakeServer((_request, url) =>
      url.pathname === "/api/rpc/banyancode.codegraph/forceKill"
        ? rpcOutput({ ok: true, message: "force-kill: not on Windows, interrupt alone is enough" })
        : undefined,
    )
    try {
      const result = await cli(root, ["codegraph", "force-kill", "--server", fake.url])
      expect(result.exitCode).toBe(0)
      expect(plain(result.stderr)).toContain("✓ force-kill: the build was interrupted")
    } finally {
      fake.stop()
    }
  }, 180_000)

  test("build indexes the root, remove clears it, and a second remove is a no-op", async () => {
    const build = await cli(root, ["codegraph", "build", "--root", project, "--timeout", "120", "--server", server.url])
    expect(build.exitCode).toBe(0)
    expect(build.stderr).toContain("Building codegraph")
    expect(build.stderr).toContain(`root:   ${project}`)
    expect(build.stderr).toContain("✓ codegraph built (indexed 2")
    expect(build.stderr).toMatch(/indexed 2, skipped \d+, \d+\.\d+s/)

    const remove = await cli(root, ["codegraph", "remove", "--root", project, "--server", server.url])
    expect(remove.exitCode).toBe(0)
    expect(remove.stderr).toMatch(/✓ Codegraph index removed\. Freed \d+ bytes/)

    const again = await cli(root, ["codegraph", "remove", "--root", project, "--server", server.url])
    expect(again.exitCode).toBe(0)
    expect(again.stderr).toContain("Codegraph index was already empty.")
  }, 180_000)

  test("trace prints the last events newest-first", async () => {
    const traceDir = path.join(project, ".banyancode", "trace")
    await fs.mkdir(traceDir, { recursive: true })
    await fs.writeFile(
      path.join(traceDir, "ses_trace.jsonl"),
      [
        JSON.stringify({
          event: "repository_route",
          originalTool: "repository_query",
          arguments: { query: "hello" },
          route: "codegraph",
          backend: "codegraph",
          confidence: 0.9,
          latencyMs: 12,
          ts: 1_700_000_000_000,
          sessionID: "ses_trace",
        }),
        JSON.stringify({ type: "tool.call", phase: "start", tool: "read", input: { path: "a.ts" }, ts: 1_700_000_000_100, sessionID: "ses_trace" }),
      ].join("\n"),
    )

    const result = await cli(root, ["codegraph", "trace", "--session", "ses_trace", "--worktree", project])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Trace for session ses_trace")
    expect(result.stderr).toContain("events: 2 (showing last 2)")
    expect(result.stderr).toContain("TIME")
    expect(result.stderr).toContain("TOOL")
    expect(result.stderr).toContain("INPUT-SUMMARY")
    expect(result.stderr).toContain("repository_query")
    expect(result.stderr).toContain("codegraph via codegraph")
    expect(result.stderr).toContain("read")

    const missing = await cli(root, ["codegraph", "trace", "--session", "ses_missing", "--worktree", project])
    expect(missing.stderr).toContain("no traces for session ses_missing")
  }, 120_000)
})
