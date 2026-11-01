// End-to-end against a REAL v2 server: boots the built CLI (`serve --stdio`)
// in an isolated data/config/home root, then drives it through this package's
// session port and task engine.
//
// Skipped when the CLI binary is missing (source checkouts without a build).
// No credentials are assumed: if the server has no provider configured the
// delegated prompt fails, which is still a valid end-to-end shape (session
// created → execution failed → task failed with an error).

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSessionPort } from "../src/session-client"
import { TaskEngine } from "../src/engine"
import { resolveConfig } from "../src/config"
import { decodeCursor } from "../src/digest"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const binary = process.env["BANYANCODE_MCP_TEST_BIN"] ?? path.join(repoRoot, "packages", "cli", "dist", "cli-windows-x64", "bin", "opencode.exe")
const available = existsSync(binary)

const root = available ? mkdtempSync(path.join(tmpdir(), "banyancode-mcp-integration-")) : ""
const project = root === "" ? "" : path.join(root, "project")

type Server = {
  url: string
  password: string
  proc: ReturnType<typeof Bun.spawn>
  stderr: () => string
}

const systemEnv = process.env
// The built binary is branded: BANYANCODE_* is mapped onto the internal
// OPENCODE_* namespace at boot and every pre-existing OPENCODE_* value is
// dropped. Isolation therefore has to be expressed in the BanyanCode
// namespace, and the ambient variables of the outer BanyanCode session are
// stripped so the test never reaches the real service or data directory.
const cleanEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(systemEnv)) {
    if (value === undefined) continue
    if (key.startsWith("OPENCODE_") || key.startsWith("BANYANCODE_")) continue
    env[key] = value
  }
  return env
}

const bootServer = async (): Promise<Server> => {
  for (const directory of ["config", "data", "state", "cache", "home", "project", "tmp"]) {
    mkdirSync(path.join(root, directory), { recursive: true })
  }
  const password = "integration-password"
  const proc = Bun.spawn([binary, "serve", "--stdio", "--port", "0"], {
    cwd: project,
    env: {
      ...cleanEnv(),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      BANYANCODE_CONFIG_DIR: path.join(root, "config"),
      BANYANCODE_TEST_HOME: path.join(root, "home"),
      BANYANCODE_DB: "integration.db",
      BANYANCODE_PASSWORD: password,
      BANYANCODE_CONFIG_PROJECT_DISABLE: "1",
      BANYANCODE_DISABLE_CLAUDE_CODE: "1",
      BANYANCODE_DISABLE_MODELS_FETCH: "1",
      BANYANCODE_DISABLE_FFF: "1",
      TEMP: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      PWD: project,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  let stderr = ""
  void (async () => {
    const stream = proc.stderr.getReader()
    const decode = new TextDecoder()
    for (;;) {
      const { value, done } = await stream.read()
      if (done) return
      stderr += decode.decode(value)
    }
  })()
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
    const line = buffer.split("\n").find((item) => item.trim().startsWith("{"))
    if (line === undefined) continue
    try {
      const parsed = JSON.parse(line) as { url?: string }
      if (parsed.url !== undefined) return { url: parsed.url, password, proc, stderr: () => stderr }
    } catch {
      // keep reading
    }
  }
  proc.kill()
  throw new Error(`server did not print a url; output: ${buffer.slice(0, 2000)}; stderr: ${stderr.slice(-3000)}`)
}

const authHeaders = (password: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
})

describe("real v2 server integration", () => {
  let server: Server | undefined

  afterAll(async () => {
    if (server !== undefined) {
      server.proc.kill()
      await server.proc.exited.catch(() => undefined)
    }
    if (root !== "") rmSync(root, { recursive: true, force: true })
  })

  test.skipIf(!available)(
    "creates sessions, streams events, and rehydrates engine state against a live server",
    async () => {
      server = await bootServer()
      const port = createSessionPort({
        baseUrl: server.url,
        headers: authHeaders(server.password),
        root: project,
      })

      const events: string[] = []
      const unsubscribe = port.subscribeEvents((event) => events.push(event.type))
      await Bun.sleep(300)

      const created = await port.createSession({
        title: "[banyan] integration",
        metadata: { origin: "banyan-mcp", banyan_task: "btask_integration" },
        directory: project,
      })
      expect(created.id.startsWith("ses_")).toBe(true)

      const session = await port.getSession({ sessionID: created.id })
      expect(session?.metadata.origin).toBe("banyan-mcp")
      expect(session?.metadata.banyan_task).toBe("btask_integration")
      expect(session?.location?.replaceAll("\\", "/")).toBe(project.replaceAll("\\", "/"))

      const log = await port.log({ sessionID: created.id })
      // The default host does not persist durable events; either shape is fine.
      expect(Array.isArray(log)).toBe(true)

      const config = resolveConfig({ cwd: project, configPath: path.join(project, "banyan.json"), env: {} })
      const engine = new TaskEngine({ port, config, root: project, sweepIntervalMs: 5_000 })
      try {
        const restored = await engine.rehydrateAll()
        expect(restored.map((record) => record.handle)).toContain("btask_integration")

        const record = await engine.start({ prompt: "Reply with the single word: pong", mcpClient: "integration" })
        expect(record.status).toBe("running")

        // Give the task a bounded window to settle. Credentials may or may not
        // be present; either terminal status (done/failed) is a valid outcome.
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const status = await engine.status(record.handle)
          if (status.status === "done" || status.status === "failed") break
          await Bun.sleep(1_000)
        }
        const settled = engine.get(record.handle)
        expect(["done", "failed", "running"]).toContain(settled.status)
        // The location-scoped live stream delivered durable digest events
        // (execution/step/tool frames) while the task ran.
        expect(events.length).toBeGreaterThan(0)
        expect(events).toContain("durable")

        const { report } = await engine.checkup({ cursorState: {} })
        const task = report.tasks.find((item) => item.task_id === record.handle)!
        expect(task).toBeDefined()
        expect(typeof report.cursor).toBe("string")
        expect(Object.keys(decodeCursor(report.cursor))).toContain(record.handle)
        // The digest saw the run no matter which source (log/live/transcript).
        const digested = task.progress.steps + task.progress.tool_calls
        expect(digested).toBeGreaterThanOrEqual(settled.status === "failed" ? 0 : 1)

        const result = await engine.result(record.handle, "summary")
        expect(result.task_id).toBe(record.handle)
        expect(typeof result.summary.steps).toBe("number")

        const tree = engine.tree()
        expect(tree.some((node) => node.task_id === record.handle)).toBe(true)

        // Restart recovery: a fresh engine (as after an MCP client restart)
        // rehydrates the handle from session metadata and rebuilds the digest
        // from the transcript, since the default host does not persist the
        // durable event log.
        const restarted = new TaskEngine({ port, config, root: project, sweepIntervalMs: 60_000 })
        try {
          const restoredAgain = await restarted.rehydrateAll().catch((error: unknown) => {
            throw new Error(
              `rehydrate after restart failed (server exit=${server?.proc.exitCode ?? "alive"}): ` +
                `${error instanceof Error ? error.message : String(error)}; stderr: ${server?.stderr().slice(-4000) ?? ""}`,
            )
          })
          expect(restoredAgain.some((item) => item.handle === record.handle)).toBe(true)
          const after = await restarted.checkup({ cursorState: {} })
          const rebuilt = after.report.tasks.find((item) => item.task_id === record.handle)
          expect(rebuilt).toBeDefined()
          if (settled.status === "done") expect(rebuilt!.progress.steps).toBeGreaterThan(0)
        } finally {
          restarted.close()
        }

        await engine.cancel(record.handle)
        const cancelled = engine.get(record.handle)
        expect(["cancelled", "done", "failed"]).toContain(cancelled.status)
      } finally {
        engine.close()
        unsubscribe()
      }
    },
    // Session creation and the first (credential-less) run can take minutes on
    // a loaded machine; the assertions are all bounded by their own deadlines.
    360_000,
  )
})
