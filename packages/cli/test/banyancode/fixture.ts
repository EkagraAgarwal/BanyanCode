/**
 * Test harness for the BanyanCode CLI subcommands.
 *
 * Two shapes:
 *   - `startServer` boots a real isolated `serve` process (the plugin really
 *     registers its RPC namespaces) and `cli` runs a real CLI subprocess
 *     against it. Cold start is ~5-15s, so server-backed tests pass an
 *     explicit timeout.
 *   - `fakeServer` answers the handful of HTTP routes a command touches, which
 *     keeps shape/format assertions fast and deterministic.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "../fixture/environment"
import { OPENCODE_VERSION } from "../../src/version"

export const CLI_ROOT = path.join(import.meta.dir, "../..")
export const CLI_ENTRY = path.join(CLI_ROOT, "src/index.ts")
export const PASSWORD = "banyancode-cli-test"

export type CliResult = { stdout: string; stderr: string; exitCode: number }

/** Strip the v1 ANSI palette so assertions can match contiguous text. */
export const plain = (value: string) => value.replace(/\[[0-9;]*m/g, "")

export function envFor(root: string, extra: Record<string, string | undefined> = {}) {
  return isolatedEnv(root, {
    BANYANCODE_SERVER_PASSWORD: PASSWORD,
    BANYANCODE_PROJECT_DB_DIR: path.join(root, "projects"),
    // The plugin otherwise kicks a background build of the CLI repo on boot,
    // which races every codegraph assertion.
    BANYANCODEGRAPH_BOOTSTRAP: "0",
    BANYANCODE_DISABLE_WEBSEARCH: undefined,
    DO_NOT_TRACK: undefined,
    BANYANCODE_TELEMETRY: undefined,
    ...extra,
  })
}

export async function tmpRoot(prefix = "banyancode-cli-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function cli(
  root: string,
  args: ReadonlyArray<string>,
  options: { env?: Record<string, string | undefined>; timeout?: number } = {},
): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, "run", CLI_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: envFor(root, options.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => {
    try {
      child.kill()
    } catch {}
  }, options.timeout ?? 120_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timer)
  }
}

async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp, timeoutMs: number) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }) as const),
      ])
      if (result.done) break
      text += decoder.decode(result.value, { stream: true })
      const match = pattern.exec(text)
      if (match) return match
    }
  } finally {
    reader.releaseLock()
  }
  throw new Error(`server did not report readiness:\n${text}`)
}

export type RunningServer = { readonly url: string; readonly stop: () => Promise<void> }

/** Boot a real isolated server; the caller must `stop()` it in `afterAll`. */
export async function startServer(root: string, extraEnv: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, "run", CLI_ENTRY, "serve", "--port", "0"], {
    cwd: CLI_ROOT,
    env: envFor(root, extraEnv),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stop = async () => {
    try {
      child.kill()
    } catch {}
    await child.exited.catch(() => {})
  }
  try {
    const match = await readUntil(child.stdout, /server listening on (http:\/\/\S+)/, 150_000)
    const url = match[1]
    if (!url) throw new Error("server printed no URL")
    return { url, stop } satisfies RunningServer
  } catch (error) {
    await stop()
    const stderr = await new Response(child.stderr).text().catch(() => "")
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`)
  }
}

export type FakeRoute = (request: Request, url: URL) => Response | undefined | Promise<Response | undefined>

/** Minimal HTTP stand-in: `/api/info` health plus whatever routes the test adds. */
export function fakeServer(route: FakeRoute) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info") {
        return Response.json({
          version: OPENCODE_VERSION,
          pid: process.pid,
          urls: [],
          paths: { tmp: os.tmpdir() },
        })
      }
      const response = await route(request, url)
      return response ?? new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

/** RPC reply body: `POST /api/rpc/:rpcID/:method` answers `{ output }`. */
export function rpcOutput(output: unknown) {
  return Response.json({ output })
}

/** A tiny project the codegraph can index in well under a second. */
export async function tinyProject(root: string) {
  const project = path.join(root, "project")
  await fs.mkdir(path.join(project, "src"), { recursive: true })
  await fs.writeFile(
    path.join(project, "src", "greeter.ts"),
    [
      "export function hello(name: string) {",
      "  return `hello ${name}`",
      "}",
      "",
      "export class Greeter {",
      "  greet(name: string) {",
      "    return hello(name)",
      "  }",
      "}",
      "",
    ].join("\n"),
  )
  await fs.writeFile(
    path.join(project, "src", "greeter.test.ts"),
    ['import { hello } from "./greeter"', "", 'test("hello", () => {', '  expect(hello("x")).toBe("hello x")', "})", ""].join(
      "\n",
    ),
  )
  return project
}
