// `--cwd` != process cwd over real stdio (gap-plan §2.3 backup).
//
// Spawns the REAL CLI with the child process cwd set to an empty directory B
// while `--cwd` points at repo A. The sibling server test covers the
// unit-level path guard; this test proves end to end that the served tools
// answer from the `--cwd` repo, not from wherever the process happened to
// start.
//
// Observable: `banyan_codegraph build` with NO `root` (minimal args, §2.2)
// echoes the resolved `root` it indexed. Pre-A2 that call is a tool error
// mentioning "root" (informative pass); once A1-A3 land it succeeds and the
// echoed root must resolve inside A, never inside B.

import { describe, expect, test } from "bun:test"
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { tmpdir } from "../fixture/tmpdir"

const PACKAGE_DIR = path.resolve(import.meta.dir, "../..")
const CLI_ENTRY = path.join(PACKAGE_DIR, "src/index.ts")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what} after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

const normalize = (p: string): string => {
  const resolved = path.resolve(p)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

const isInside = (root: string, candidate: string): boolean => {
  const rel = path.relative(normalize(root), normalize(candidate))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

describe("mcp stdio with --cwd != process cwd (real CLI)", () => {
  test(
    "tools answer from the --cwd repo; stdout stays pure JSON-RPC",
    async () => {
      await using repoA = await tmpdir()
      await using otherCwd = await tmpdir()
      await fs.mkdir(path.join(repoA.path, "src"), { recursive: true })
      await fs.writeFile(path.join(repoA.path, "src", "widget.ts"), "export function Widget() { return 1 }\n")
      const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-cwd-home-")))
      const child: ChildProcessWithoutNullStreams = spawn(
        process.execPath,
        ["run", "--conditions=browser", CLI_ENTRY, "mcp", "serve", "--cwd", repoA.path],
        {
          cwd: otherCwd.path,
          env: {
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
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      const stdoutLines: string[] = []
      let stderr = ""
      let buffer = ""
      const waiters: Array<(msg: any) => void> = []
      const queued: any[] = []
      let exited = false
      child.on("exit", () => {
        exited = true
        for (const w of waiters.splice(0)) w({ _exited: true })
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
        if (queuedMsg !== undefined) return Promise.resolve(queuedMsg)
        return withTimeout(
          new Promise<any>((resolve) => waiters.push(resolve)),
          timeoutMs,
          `${what}\nstderr:\n${stderr.slice(-2000)}`,
        )
      }
      const close = async (): Promise<void> => {
        child.stdin.end()
        const deadline = Date.now() + 8_000
        while (!exited && Date.now() < deadline) await sleep(100)
        if (!exited) child.kill()
        const killDeadline = Date.now() + 3_000
        while (!exited && Date.now() < killDeadline) await sleep(100)
        if (!exited && child.pid !== undefined) {
          try {
            await new Promise<void>((resolve) => {
              execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], () => resolve())
            })
          } catch {
            // best effort
          }
        }
        await fs.rm(home, { recursive: true, force: true }).catch(() => {})
      }

      try {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cwd-mismatch-test", version: "0.0.0-test" } } })}\n`,
        )
        const init = await next(30_000, "initialize")
        expect(init.id).toBe(1)
        expect(init.error ?? null).toBeNull()
        expect(typeof init.result?.serverInfo?.name).toBe("string")
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)

        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`)
        const listed = await next(20_000, "tools/list")
        expect(listed.id).toBe(2)
        expect(listed.error ?? null).toBeNull()
        const names = (listed.result?.tools ?? []).map((t: { name: string }) => t.name).sort()
        expect(names).toEqual(
          [
            "banyan_change_check",
            "banyan_code_find",
            "banyan_codegraph",
            "banyan_repo",
            "banyan_task_cancel",
            "banyan_task_reply",
            "banyan_task_result",
            "banyan_task_start",
            "banyan_task_status",
          ].sort(),
        )

        // Minimal args: no `root`. Pre-A2 this is a tool error naming the
        // missing root; post-A2/A3 it succeeds with the echoed root == A.
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "banyan_codegraph", arguments: { op: "build" } } })}\n`,
        )
        const build = await next(20_000, "tools/call banyan_codegraph build")
        expect(build.id).toBe(3)
        if (build.error !== undefined && build.error !== null) {
          throw new Error(`transport failure on codegraph build: code=${build.error.code} message=${build.error.message}`)
        }
        expect(build.result?.content?.[0]?.type).toBe("text")
        if (build.result?.isError === true) {
          // Pre-A2 shape: the tool reports the missing root instead of
          // answering from the wrong directory.
          expect(build.result.content[0].text).toContain("root")
          // eslint-disable-next-line no-console
          console.error(`[cwd-mismatch] build isError (pre-A2): ${build.result.content[0].text.slice(0, 200)}`)
        } else {
          const body = JSON.parse(build.result.content[0].text) as { started?: boolean; root?: string; dbPath?: string }
          expect(body.started).toBe(true)
          expect(typeof body.root).toBe("string")
          expect(isInside(repoA.path, body.root!)).toBe(true)
          expect(isInside(otherCwd.path, body.root!) && !isInside(repoA.path, body.root!)).toBe(false)
          expect(body.dbPath).toContain("banyancode-")
        }

        for (const line of stdoutLines) {
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            throw new Error(`stdout hygiene: non-JSON-RPC bytes on stdout: ${line.slice(0, 300)}`)
          }
          expect(msg.jsonrpc).toBe("2.0")
        }
        expect(stdoutLines.length).toBeGreaterThan(0)
      } finally {
        await close()
      }
    },
    85_000,
  )
})
