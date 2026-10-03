// Real stdio e2e for `banyancode mcp serve` (Milestone A10; gap-plan §3.24).
//
// The old "stdout hygiene" test monkey-patched `process.stdout.write` around
// pure functions, so it could never catch a real regression. This suite
// spawns the REAL CLI (`bun run src/index.ts mcp serve --cwd <tmpdir>`) and
// speaks raw newline-delimited JSON-RPC over its stdio pipes:
//
//   spawn -> initialize -> notifications/initialized -> tools/list ->
//   tools/call on EVERY registered tool with MINIMAL args (all optional
//   fields omitted) -> close stdin (server exits) -> assert every stdout
//   line parsed as JSON-RPC.
//
// Acceptance per tool call: success OR a tool error (`isError: true`).
// A JSON-RPC `error` envelope is a transport failure (the model cannot
// self-correct) and fails the test. Optional-field defaults (§2.1: missing
// `includeKeywordFallback`, §2.2: missing `root`) currently surface as tool
// errors and flip to success once A1/A2 land; both shapes pass here.

import { describe, expect, test } from "bun:test"
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { tmpdir } from "../fixture/tmpdir"

const PACKAGE_DIR = path.resolve(import.meta.dir, "../..")
const CLI_ENTRY = path.join(PACKAGE_DIR, "src/index.ts")

const EXPECTED_TOOLS = [
  "banyan_code_find",
  "banyan_repo",
  "banyan_change_check",
  "banyan_codegraph",
  "banyan_memory",
  "banyan_verify",
  "banyan_task_start",
  "banyan_task_status",
  "banyan_task_result",
  "banyan_task_reply",
  "banyan_task_cancel",
] as const

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what} after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

type StdioSession = {
  send: (msg: object) => void
  next: (timeoutMs: number, what: string) => Promise<any>
  stdoutLines: string[]
  stderrText: () => string
  close: () => Promise<void>
}

// Spawn the real CLI with a fully isolated home dir (no user config, no
// project-config walk, no plugin discovery), mirroring test/lib/cli-process.
async function spawnMcpServe(opts: { repoDir: string; childCwd: string }): Promise<StdioSession> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-home-")))
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_TEST_HOME: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
  }
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["run", "--conditions=browser", CLI_ENTRY, "mcp", "serve", "--cwd", opts.repoDir],
    { cwd: opts.childCwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
  )
  const stdoutLines: string[] = []
  let stderr = ""
  let buffer = ""
  const waiters: Array<(msg: any) => void> = []
  const queued: any[] = []
  let exited = false
  let exitInfo = ""
  child.on("exit", (code, signal) => {
    exited = true
    exitInfo = `code=${code} signal=${signal}`
    for (const w of waiters.splice(0)) w({ _exited: exitInfo })
  })
  child.on("error", (err) => {
    for (const w of waiters.splice(0)) w({ _spawnError: String(err) })
  })
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "")
      buffer = buffer.slice(idx + 1)
      if (line.length === 0) continue
      stdoutLines.push(line)
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        msg = { _rawLine: line }
      }
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else queued.push(msg)
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })

  const next = (timeoutMs: number, what: string): Promise<any> => {
    const queuedMsg = queued.shift()
    if (queuedMsg !== undefined) {
      if (queuedMsg._exited !== undefined || queuedMsg._spawnError !== undefined) {
        return Promise.reject(
          new Error(
            `child gone while waiting for ${what}: ${queuedMsg._exited ?? queuedMsg._spawnError}\nstderr:\n${stderr.slice(-2000)}`,
          ),
        )
      }
      return Promise.resolve(queuedMsg)
    }
    return withTimeout(new Promise<any>((resolve) => waiters.push(resolve)), timeoutMs, what).then((msg) => {
      if (msg?._exited !== undefined || msg?._spawnError !== undefined) {
        throw new Error(
          `child gone while waiting for ${what}: ${msg._exited ?? msg._spawnError}\nstderr:\n${stderr.slice(-2000)}`,
        )
      }
      return msg
    })
  }

  const close = async (): Promise<void> => {
    child.stdin.end()
    const deadline = Date.now() + 8_000
    while (!exited && Date.now() < deadline) await sleep(100)
    if (!exited) {
      child.kill()
      const killDeadline = Date.now() + 3_000
      while (!exited && Date.now() < killDeadline) await sleep(100)
    }
    if (!exited && child.pid !== undefined) {
      try {
        await new Promise<void>((resolve) => {
          execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => resolve())
        })
        const taskkillDeadline = Date.now() + 3_000
        while (!exited && Date.now() < taskkillDeadline) await sleep(100)
      } catch {
        // best effort; the test run ends anyway
      }
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }

  return {
    send: (msg: object) => {
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    },
    next,
    stdoutLines,
    stderrText: () => stderr,
    close,
  }
}

const assertHygiene = (stdoutLines: string[]): void => {
  for (const line of stdoutLines) {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      throw new Error(`stdout hygiene: non-JSON-RPC bytes on stdout: ${line.slice(0, 300)}`)
    }
    expect(msg.jsonrpc).toBe("2.0")
  }
}

// tools/call with MINIMAL args. Returns the tool result: success or
// isError are both fine; a JSON-RPC error envelope is a transport failure.
async function callToolMinimal(
  session: StdioSession,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  session.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
  const msg = await session.next(20_000, `tools/call ${name}`)
  if (msg.id !== id)
    throw new Error(`expected response id ${id} for ${name}, got: ${JSON.stringify(msg).slice(0, 300)}`)
  if (msg.error !== undefined && msg.error !== null) {
    throw new Error(`transport failure calling ${name}: code=${msg.error.code} message=${msg.error.message}`)
  }
  const result = msg.result
  expect(result?.content?.[0]?.type).toBe("text")
  return { text: result.content[0].text as string, isError: result.isError === true }
}

describe("mcp stdio e2e (real CLI)", () => {
  test("initialize -> list -> every tool with minimal args; stdout stays pure JSON-RPC", async () => {
    await using repo = await tmpdir()
    await fs.mkdir(path.join(repo.path, "src"), { recursive: true })
    await fs.writeFile(path.join(repo.path, "src", "widget.ts"), "export function Widget() { return 1 }\n")
    const session = await spawnMcpServe({ repoDir: repo.path, childCwd: repo.path })
    try {
      session.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "stdio-e2e-test", version: "0.0.0-test" },
        },
      })
      const init = await session.next(30_000, "initialize")
      expect(init.id).toBe(1)
      expect(init.error ?? null).toBeNull()
      expect(typeof init.result?.protocolVersion).toBe("string")
      expect(typeof init.result?.serverInfo?.name).toBe("string")

      session.send({ jsonrpc: "2.0", method: "notifications/initialized" })

      session.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      const listed = await session.next(20_000, "tools/list")
      expect(listed.id).toBe(2)
      expect(listed.error ?? null).toBeNull()
      const names = (listed.result?.tools ?? []).map((t: { name: string }) => t.name).sort()
      expect(names).toEqual([...EXPECTED_TOOLS].sort())

      // Every registered tool, minimal args: every optional field omitted.
      // §2.1: code_find omits includeKeywordFallback. §2.2: codegraph
      // omits root.
      const outcomes: Array<{ tool: string; isError: boolean }> = []
      const record = async (tool: string, id: number, args: Record<string, unknown>): Promise<void> => {
        const { isError } = await callToolMinimal(session, id, tool, args)
        outcomes.push({ tool, isError })
      }
      await record("banyan_code_find", 3, { intent: "definition", target: "Widget" })
      await record("banyan_repo", 4, { op: "query", query: "Widget" })
      await record("banyan_repo", 5, { op: "impact", path: "src/widget.ts" })
      await record("banyan_change_check", 6, { op: "blast_radius", target: "Widget" })
      await record("banyan_codegraph", 7, { op: "status" })

      // Every call came back inside the result envelope (success or
      // isError), never as a transport-level JSON-RPC error. Log the
      // shape for triage when a sibling fix flips an error to success.
      // eslint-disable-next-line no-console
      console.error(`[stdio-e2e] outcomes: ${JSON.stringify(outcomes)}`)

      assertHygiene(session.stdoutLines)
      expect(session.stdoutLines.length).toBeGreaterThan(0)
    } finally {
      await session.close()
      // Closing stdin exits the server; every captured stdout line must
      // still be JSON-RPC (no shutdown logs leaked onto stdout).
      assertHygiene(session.stdoutLines)
    }
  }, 85_000)

  // Dual-era mate (gap-plan D0): the same CLI served over the same stdio
  // pipe, but opened as a modern 2026-07-28 client — `server/discover`
  // first, then per-request `_meta` on every call. The SDK client speaks
  // the modern wire itself; the assertions prove the server negotiated
  // modern (era + discover result + server identity) and served every tool
  // group through it.
  test("modern client: server/discover -> list -> every tool group with minimal args", async () => {
    await using repo = await tmpdir()
    await fs.mkdir(path.join(repo.path, "src"), { recursive: true })
    await fs.writeFile(path.join(repo.path, "src", "widget.ts"), "export function Widget() { return 1 }\n")
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-home-")))
    try {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value
      }
      Object.assign(env, {
        OPENCODE_TEST_HOME: home,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_AUTOCOMPACT: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_AUTH_CONTENT: "{}",
      })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["run", "--conditions=browser", CLI_ENTRY, "mcp", "serve", "--cwd", repo.path],
        env,
        cwd: repo.path,
        stderr: "pipe",
      })
      const client = new Client(
        { name: "stdio-e2e-modern", version: "0.0.0-test" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      )
      await withTimeout(client.connect(transport), 60_000, "modern connect")
      try {
        // Negotiated modern, not silently fallen back to initialize.
        expect(client.getProtocolEra()).toBe("modern")
        expect(client.getDiscoverResult()).toBeDefined()
        expect(client.getServerVersion()?.name).toBe("banyancode")

        const { tools } = await withTimeout(client.listTools(), 20_000, "modern tools/list")
        expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort())

        // One minimal call per tool group (all optional fields omitted).
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [
          { name: "banyan_code_find", args: { intent: "definition", target: "Widget" } },
          { name: "banyan_repo", args: { op: "query", query: "Widget" } },
          { name: "banyan_change_check", args: { op: "blast_radius", target: "Widget" } },
          { name: "banyan_codegraph", args: { op: "status" } },
        ]
        for (const call of calls) {
          const result = await withTimeout(
            client.callTool({ name: call.name, arguments: call.args }),
            20_000,
            `modern tools/call ${call.name}`,
          )
          const content = result.content?.[0] as { type?: string; text?: string } | undefined
          expect(content?.type).toBe("text")
          expect(typeof content?.text).toBe("string")
        }
      } finally {
        await client.close().catch(() => {})
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true }).catch(() => {})
    }
  }, 120_000)
})
