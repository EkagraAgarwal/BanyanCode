// Subprocess test: the SOURCE CLI must answer the MCP handshake over stdio and
// keep stdout free of anything that is not a JSON-RPC frame. This is the exact
// invocation Claude Code is configured with (`banyancode mcp serve`).
//
// The server attaches to an unreachable URL on purpose: the handshake and
// tools/list never touch the network, so no background service is spawned and
// no BanyanCode data directory is read or written.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const cliPackage = path.join(repoRoot, "packages", "cli")
const cli = path.join(cliPackage, "src", "index.ts")

type Frame = {
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: unknown
}

const root = mkdtempSync(path.join(tmpdir(), "banyancode-mcp-stdio-"))
const project = path.join(root, "project")
mkdirSync(project, { recursive: true })
for (const directory of ["config", "data", "state", "cache", "home", "tmp"]) {
  mkdirSync(path.join(root, directory), { recursive: true })
}

type Server = {
  proc: ReturnType<typeof Bun.spawn>
  stdin: Bun.FileSink
  send: (frame: Record<string, unknown>) => void
  next: () => Promise<{ frame: Frame; line: string }>
}

const isolatedEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("OPENCODE_") || key.startsWith("BANYANCODE_")) continue
    if (key === "XDG_DATA_HOME" || key === "XDG_CONFIG_HOME" || key === "XDG_STATE_HOME" || key === "XDG_CACHE_HOME") {
      continue
    }
    if (key === "HOME" || key === "USERPROFILE" || key === "TEMP" || key === "TMP" || key === "CODEX_HOME") continue
    env[key] = value
  }
  return {
    ...env,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    OPENCODE_DB: "stdio-test.db",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
  }
}

const boot = (): Server => {
  const proc = Bun.spawn(
    [
      process.execPath,
      cli,
      "mcp",
      "serve",
      "--cwd",
      project,
      "--attach",
      "http://127.0.0.1:1",
      "--no-rehydrate",
    ],
    {
      // The source CLI must run from its package directory: that is where the
      // tsconfig with the Solid JSX runtime lives (`bun run dev` does the same).
      cwd: cliPackage,
      env: isolatedEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdin = proc.stdin
  if (typeof stdin === "number") throw new Error("expected a piped stdin")
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const next = async (): Promise<{ frame: Frame; line: string }> => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const newline = buffer.indexOf("\n")
      if (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === "") continue
        // Any non-JSON line on stdout corrupts the MCP stream: fail loudly.
        return { frame: JSON.parse(line) as Frame, line }
      }
      const { value, done } = await reader.read()
      if (done) throw new Error(`stdout closed while waiting for a frame; pending=${JSON.stringify(buffer)}`)
      buffer += decoder.decode(value, { stream: true })
    }
    throw new Error(`timed out waiting for a frame; pending=${JSON.stringify(buffer)}`)
  }
  return {
    proc,
    stdin,
    send: (frame) => {
      stdin.write(`${JSON.stringify(frame)}\n`)
      stdin.flush()
    },
    next,
  }
}

const waitForId = async (server: Server, id: number): Promise<Frame> => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { frame } = await server.next()
    if (frame.id === id) return frame
  }
  throw new Error(`no response with id ${id}`)
}

describe("banyancode mcp serve over stdio", () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("answers initialize and tools/list with clean stdout", async () => {
    const server = boot()
    try {
      server.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "banyancode-stdio-test", version: "1.0.0" },
        },
      })
      const initialized = await waitForId(server, 1)
      expect(initialized.error).toBeUndefined()
      const result = initialized.result as { serverInfo?: { name?: string }; instructions?: string }
      expect(result.serverInfo?.name).toBe("banyancode")
      expect(result.instructions).toContain("banyan_checkup")

      server.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      const listed = await waitForId(server, 2)
      expect(listed.error).toBeUndefined()
      const tools = (listed.result as { tools?: Array<{ name: string }> }).tools ?? []
      const names = tools.map((tool) => tool.name)
      expect(names).toContain("banyan_task_start")
      expect(names).toContain("banyan_checkup")
      expect(names).toContain("banyan_code_find")
      expect(names).toContain("banyan_repo")
      expect(names).toContain("banyan_verify")
      expect(names).not.toContain("banyan_memory")
    } finally {
      server.stdin.end()
      server.proc.kill()
      await server.proc.exited.catch(() => undefined)
    }
  }, 120_000)
})
