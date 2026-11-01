#!/usr/bin/env bun
// BanyanCode binary smoke test.
//
//   bun script/banyancode/smoke.ts [--bin <path>] [--keep] [--timeout-ms <n>]
//
// Runs a real BanyanCode binary in a fresh, isolated root (temp HOME + XDG_*
// dirs, temp TMP) and checks the shipped surface. Every check prints PASS/FAIL
// with the evidence; the process exits 1 when anything fails. Nothing is faked:
// a feature that is not wired yet reports the exact RPC/CLI error instead of
// being skipped.
//
// Isolation rules reproduced here (see spike-build/run-probe.ps1):
//   - packages/util/src/global-roots.ts reads XDG_* and os.homedir() at module
//     load, so HOME/USERPROFILE/XDG_*/TEMP are all redirected before spawn.
//   - packages/cli/src/env-map.ts deletes every inherited OPENCODE_* value, so
//     OPENCODE_CONFIG_DIR must never be honoured; BANYANCODE_* is mapped.
//   - the plugin database lives at <data>/projects/banyancode-<hash><-channel>.db
//     (packages/banyancode/src/storage/paths.ts); the host session database
//     comes from packages/cli/src/database-path.ts and is checked separately.
//   - BANYANCODEGRAPH_BOOTSTRAP=0 makes the explicit `codegraph.build` RPC the
//     only builder, so a background bootstrap cannot race the smoke's checks.
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { channelForVersion } from "./version"

type Status = "PASS" | "FAIL"
type Result = { readonly name: string; readonly status: Status; readonly detail: string }

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(`--${name}=`.length)
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  const next = args[index + 1]
  return next !== undefined && !next.startsWith("--") ? next : undefined
}
const keep = args.includes("--keep")

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "usage: bun script/banyancode/smoke.ts [options]",
      "",
      "  --bin <path>       binary to test (default: packages/cli/dist/dev/banyancode[.exe])",
      "  --timeout-ms <n>   startup/build timeout, ms (default: 120000)",
      "  --keep             keep the isolated root for inspection",
      "  -h, --help         show this help",
    ].join("\n"),
  )
  process.exit(0)
}

const repo = path.resolve(import.meta.dir, "../..")
const executable = process.platform === "win32" ? "banyancode.exe" : "banyancode"
const binary = path.resolve(flag("bin") ?? path.join(repo, "packages", "cli", "dist", "dev", executable))
const startupTimeout = Number(flag("timeout-ms") ?? "120000")
const buildTimeout = Math.max(startupTimeout, 180_000)

if (!existsSync(binary)) {
  console.error(`smoke: binary not found at ${binary}\n  build one first: bun script/banyancode/dev-build.ts`)
  process.exit(2)
}

const expected = await Bun.file(path.join(path.dirname(binary), "build.json"))
  .json()
  .then((value: unknown) => value as { version?: string; channel?: string } | undefined)
  .catch(() => undefined)

const results: Result[] = []

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run()
    results.push({ name, status: "PASS", detail })
  } catch (error) {
    results.push({ name, status: "FAIL", detail: error instanceof Error ? error.message : String(error) })
  }
}

// ---------------------------------------------------------------- isolation

const root = await mkdtemp(path.join(os.tmpdir(), "banyancode-smoke-"))
const homeDir = path.join(root, "home")
const projectDir = path.join(root, "project")
const tmpDir = path.join(root, "tmp")
const decoyConfigDir = path.join(root, "decoy-config")
const stockConfigDir = path.join(homeDir, ".config", "opencode")
const stockHomeDotDir = path.join(homeDir, ".opencode")

for (const directory of [homeDir, projectDir, tmpDir, decoyConfigDir, stockConfigDir, stockHomeDotDir]) {
  await mkdir(directory, { recursive: true })
}
await writeFile(
  path.join(stockConfigDir, "opencode.json"),
  `${JSON.stringify({ $schema: "https://opencode.ai/config.json", username: "stock-opencode" }, null, 2)}\n`,
)
await writeFile(
  path.join(stockHomeDotDir, "opencode.json"),
  `${JSON.stringify({ $schema: "https://opencode.ai/config.json", username: "stock-opencode-project" }, null, 2)}\n`,
)
await writeFile(
  path.join(decoyConfigDir, "opencode.json"),
  `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "decoy/should-not-be-read" }, null, 2)}\n`,
)

// Project config that must be honoured, plus a small TS project whose graph the
// codegraph build indexes. `broken.ts` has a real syntax error, which is the
// documented proof that the tree-sitter backend ran (regex parsers never
// report syntax errors).
await writeFile(
  path.join(projectDir, "banyancode.json"),
  `${JSON.stringify({ $schema: "https://banyan.dev/schema/banyancode.json", banyancode_max_subagents: 3 }, null, 2)}\n`,
)
await mkdir(path.join(projectDir, "src"), { recursive: true })
await writeFile(
  path.join(projectDir, "src", "util.ts"),
  [
    "export function add(a: number, b: number): number {",
    "  return a + b",
    "}",
    "",
    "export class Greeter {",
    "  greet(name: string): string {",
    '    return "hello " + name',
    "  }",
    "}",
    "",
  ].join("\n"),
)
await writeFile(
  path.join(projectDir, "src", "index.ts"),
  [
    'import { add, Greeter } from "./util"',
    "",
    "export function main(): string {",
    "  const greeter = new Greeter()",
    "  return greeter.greet(String(add(1, 2)))",
    "}",
    "",
  ].join("\n"),
)
await writeFile(
  path.join(projectDir, "src", "broken.ts"),
  ["export function broken(: number {", "  return 1", "}", ""].join("\n"),
)
// A bare temp directory inherits any parent git repo. If the developer's HOME is
// a dotfiles repo, the host resolves that HOME as the project and the codegraph
// bootstrap tries to index the whole home directory (>1 minute, and the build
// state then describes another root). Making the generated project its own repo
// keeps the run isolated and the graph small.
const gitInit = Bun.spawnSync(["git", "init", "-q", "."], { cwd: projectDir, stdout: "pipe", stderr: "pipe" })
if (gitInit.exitCode !== 0) {
  console.warn(`warn: git init failed in ${projectDir}; the project may inherit a parent repository`)
}

const password = `smoke-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Drop every inherited product variable: brand-env would delete OPENCODE_*
    // in the child anyway, but BANYANCODE_* must not leak the developer's real
    // config/password into a smoke run.
    if (key.toUpperCase().startsWith("OPENCODE_") || key.toUpperCase().startsWith("BANYANCODE_")) continue
    env[key] = value
  }
  return {
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCODE_TEST_HOME: homeDir,
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_STATE_HOME: path.join(homeDir, ".local", "state"),
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    TEMP: tmpDir,
    TMP: tmpDir,
    // Stock-OpenCode variable, must be deleted by the env rewrite.
    OPENCODE_CONFIG_DIR: decoyConfigDir,
    BANYANCODE_PASSWORD: password,
    BANYANCODE_DISABLE_MODELS_FETCH: "1",
    BANYANCODE_DISABLE_CLAUDE_CODE: "1",
    BANYANCODE_DISABLE_FFF: "1",
    // Let the explicit `banyancode.codegraph.build` RPC below be the only
    // builder. The background bootstrap would start a second build on plugin
    // activation, and the smoke would then race a finished status against a
    // still-running write.
    BANYANCODEGRAPH_BOOTSTRAP: "0",
    ...extra,
  }
}

const norm = (value: string) => path.resolve(value).replaceAll("\\", "/").toLowerCase()
const inside = (child: string, parent: string) => {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(`${p}/`)
}

// ------------------------------------------------------------ process utils

type Capture = { readonly code: number; readonly stdout: string; readonly stderr: string }

async function capture(argv: readonly string[], timeoutMs = 60_000, extraEnv: Record<string, string> = {}): Promise<Capture> {
  const proc = Bun.spawn([...argv], {
    cwd: projectDir,
    env: childEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    } else {
      proc.kill()
    }
  }, timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    if (timedOut) throw new Error(`timed out after ${timeoutMs}ms: ${argv.join(" ")}\n${tail(stdout, stderr)}`)
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

const tail = (stdout: string, stderr: string, lines = 12) =>
  [stdout.trim() && `stdout:\n${stdout.trim().split(/\r?\n/).slice(-lines).join("\n")}`, stderr.trim() && `stderr:\n${stderr.trim().split(/\r?\n/).slice(-lines).join("\n")}`]
    .filter(Boolean)
    .join("\n")

/**
 * Stop a process this script started, and only that process tree. `mcp serve`
 * may spawn a private stdio server; on Windows a plain kill leaves it behind and
 * the next build then fails with EPERM on dist/. taskkill /PID targets one
 * process tree — never an image name (the host BanyanCode shares the name).
 */
async function stop(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode !== null) return
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
  } else {
    proc.kill()
  }
  const ended = await Promise.race([proc.exited.then(() => true), delay(5_000).then(() => false)])
  if (!ended && proc.exitCode === null) proc.kill("SIGKILL")
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// --------------------------------------------------------------- serve + rpc

type Server = { readonly proc: Bun.Subprocess; readonly url: string; readonly stdout: () => string; readonly stderr: () => string }

async function startServer(): Promise<Server> {
  const proc = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: projectDir,
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  })
  let out = ""
  let err = ""
  let stderrDone = false
  void new Response(proc.stderr)
    .text()
    .then((text) => {
      err = text
      stderrDone = true
    })
    .catch(() => undefined)

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let url: string | undefined
  // Never race a stream read against a timer: the abandoned read consumes the
  // chunk when it finally resolves, so the value is silently lost. A watchdog
  // that kills the process ends the read instead.
  const watchdog = setTimeout(() => proc.kill(), startupTimeout)
  try {
    while (true) {
      const read = await reader.read()
      if (read.done) break
      out += decoder.decode(read.value, { stream: true })
      const match = /server listening on (http:\/\/\S+)/.exec(out)
      if (match?.[1]) {
        url = match[1]
        break
      }
    }
  } finally {
    clearTimeout(watchdog)
  }
  // Keep draining stdout so the server never blocks on a full pipe.
  void (async () => {
    while (true) {
      const read = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (read.done) break
      out += decoder.decode(read.value, { stream: true })
    }
  })().catch(() => undefined)

  if (!url) {
    const code = proc.exitCode ?? (await Promise.race([proc.exited, delay(2_000).then(() => "running" as const)]))
    await stop(proc)
    if (!stderrDone) await Promise.race([delay(1_000), proc.exited])
    throw new Error(`server did not print 'server listening on' (exit=${String(code)})\n${tail(out, err)}`)
  }
  return {
    proc,
    url,
    stdout: () => out,
    stderr: () => err,
  }
}

type RpcResponse = { readonly status: number; readonly body: unknown; readonly text: string }
let authUsername: string | undefined

async function rpc(serverUrl: string, id: string, method: string, input: unknown, timeoutMs = 60_000): Promise<RpcResponse> {
  const url =
    `${serverUrl}/api/rpc/${encodeURIComponent(id)}/${encodeURIComponent(method)}` +
    `?location%5Bdirectory%5D=${encodeURIComponent(projectDir)}`
  const usernames = authUsername ? [authUsername] : ["opencode", "banyancode"]
  let last: RpcResponse | undefined
  for (const username of usernames) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // non-JSON error page; keep the raw text for the message
    }
    last = { status: response.status, body, text }
    if (response.status !== 401) {
      authUsername = username
      return last
    }
  }
  return last ?? { status: 0, body: undefined, text: "no response" }
}

const RPC_ERRORS = ["rpc.unavailable", "rpc.method_not_found", "rpc.invalid_input", "rpc.internal", "rpc.invalid_output"] as const
type RpcError = (typeof RPC_ERRORS)[number]

function rpcError(response: RpcResponse): RpcError | undefined {
  const text = response.text
  return RPC_ERRORS.find((type) => text.includes(`"${type}"`) || text.includes(type))
}

function output(response: RpcResponse, label = "rpc"): unknown {
  if (response.status !== 200) {
    throw new Error(`${label}: HTTP ${response.status}: ${tail(response.text, "", 4)}`)
  }
  const body = response.body
  if (typeof body === "object" && body !== null && "output" in body) return (body as { output: unknown }).output
  return body
}

// ------------------------------------------------------------- file snapshot

async function snapshot(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const walk = async (current: string): Promise<void> => {
    if (!existsSync(current)) return
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      const bytes = await readFile(absolute)
      files.set(path.relative(directory, absolute).replaceAll("\\", "/"), createHash("sha256").update(bytes).digest("hex"))
    }
  }
  await walk(directory)
  return files
}

function diffSnapshot(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = []
  for (const [file, hash] of before) {
    const next = after.get(file)
    if (next === undefined) changes.push(`${file}: deleted`)
    else if (next !== hash) changes.push(`${file}: modified`)
  }
  for (const file of after.keys()) if (!before.has(file)) changes.push(`${file}: created`)
  return changes
}

const stockBefore = {
  config: await snapshot(stockConfigDir),
  dotDir: await snapshot(stockHomeDotDir),
}
const decoyBefore = await snapshot(decoyConfigDir)

let server: Server | undefined
let failed = false

try {
  // ------------------------------------------------------------- 1. version
  let versionOutput = ""
  let expectedChannel: string | undefined
  await check("version (--version)", async () => {
    const result = await capture([binary, "--version"], 60_000)
    versionOutput = `${result.stdout}${result.stderr}`.trim()
    if (result.code !== 0) throw new Error(`exit ${result.code}\n${tail(result.stdout, result.stderr)}`)
    if (!/banyancode/i.test(versionOutput)) throw new Error(`output does not name banyancode: ${versionOutput}`)
    const version = /\d{2}\.\d{2}\.\d+(?:-[0-9a-z.]+)?/.exec(versionOutput)?.[0]
    if (!version) throw new Error(`no CalVer version in output: ${versionOutput}`)
    if (expected?.version && version !== expected.version) {
      throw new Error(`binary reports ${version}, build.json says ${expected.version}`)
    }
    expectedChannel = expected?.channel ?? channelForVersion(version)
    return versionOutput.split(/\r?\n/)[0] ?? version
  })

  // ---------------------------------------------------------------- 2. help
  await check("help (no opencode branding)", async () => {
    const result = await capture([binary, "--help"], 60_000)
    if (result.code !== 0) throw new Error(`exit ${result.code}\n${tail(result.stdout, result.stderr)}`)
    const text = `${result.stdout}${result.stderr}`
    if (!/banyancode/i.test(text)) throw new Error("help does not mention banyancode")
    // Provider names that legitimately carry the upstream brand. Everything
    // else must be BanyanCode.
    const scrubbed = text
      .replaceAll("OpenCode Zen", "")
      .replaceAll("OpenCode Go", "")
      .replaceAll("opencode.ai", "")
      .replaceAll("opencode-go", "")
    const leaked = scrubbed.split(/\r?\n/).filter((line) => /opencode/i.test(line))
    if (leaked.length > 0) throw new Error(`help mentions opencode:\n${leaked.slice(0, 5).join("\n")}`)
    return "banyancode help, no upstream branding"
  })

  // --------------------------------------------------------------- 3. paths
  let paths = new Map<string, string>()
  await check("debug paths (all under banyancode dirs)", async () => {
    const result = await capture([binary, "debug", "paths"], 60_000)
    if (result.code !== 0) throw new Error(`exit ${result.code}\n${tail(result.stdout, result.stderr)}`)
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim() === "") continue
      const key = line.slice(0, 10).trim()
      const value = line.slice(10).trim()
      if (key !== "" && value !== "") paths.set(key, value)
    }
    if (paths.size === 0) throw new Error(`no paths parsed:\n${result.stdout}`)
    if (!paths.has("db") || !paths.has("data") || !paths.has("config")) {
      throw new Error(`missing db/data/config keys: ${[...paths.keys()].join(",")}`)
    }
    const problems: string[] = []
    for (const [key, value] of paths) {
      if (!inside(value, root)) problems.push(`${key} escapes the isolated root: ${value}`)
      if (key === "home") continue
      if (!/banyancode/i.test(value)) problems.push(`${key} is not a banyancode path: ${value}`)
    }
    if (!inside(paths.get("home") ?? "", homeDir)) problems.push(`home is not the isolated home: ${paths.get("home")}`)
    if (problems.length > 0) throw new Error(problems.join("\n"))
    return `${paths.size} paths, data=${paths.get("data")}`
  })

  // ----------------------------------- 4. dev channel DB (canary isolation)
  await check("dev channel uses banyancode-dev.db", async () => {
    const db = paths.get("db") ?? ""
    const filename = path.basename(db).toLowerCase()
    if (expected?.channel !== "dev") return `not a dev binary (channel ${expected?.channel ?? "unknown"}); skipped expectation`
    if (filename !== "banyancode-dev.db") {
      throw new Error(
        `dev build resolves db=${db}; expected banyancode-dev.db so a canary never opens the stable database ` +
          `(packages/cli/src/database-path.ts keeps 'dev' in the stable-channel list)`,
      )
    }
    return filename
  })

  // --------------------------------------------------------------- 5. serve
  let serverStarted = false
  await check("serve starts with a known password", async () => {
    server = await startServer()
    serverStarted = true
    if (!server.url.startsWith("http://127.0.0.1:")) throw new Error(`unexpected listen url: ${server.url}`)
    return server.url
  })

  if (server === undefined) {
    // Everything below needs the server; report the exact reason per check.
    const reason = "serve did not start (see the previous FAIL)"
    for (const name of [
      "rpc banyancode.status (schema + db path)",
      "rpc banyancode.codegraph",
      "rpc banyancode.intel",
      "rpc banyancode.verify",
      "rpc banyancode.mesh",
      "rpc banyancode.usage",
      "rpc banyancode.system",
      "codegraph build (embedded tree-sitter grammars)",
      "project banyancode.json honoured",
      "OPENCODE_CONFIG_DIR ignored",
      "mcp serve (initialize + tools/list)",
      "stock OpenCode dirs untouched",
    ]) {
      results.push({ name, status: "FAIL", detail: reason })
    }
    failed = true
  } else {
    const url = server.url

    // ------------------------------------------------------------ 6. status
    let status: {
      plugin?: string
      host?: { name?: string; version?: string; channel?: string }
      database?: { path?: string; schemaVersion?: number; driver?: string }
      config?: { sources?: string[] }
    } = {}
    await check("rpc banyancode.status (schema + db path)", async () => {
      const response = await rpc(url, "banyancode", "status", {})
      const value = output(response) as typeof status
      status = value
      if (value.plugin !== "banyancode") throw new Error(`plugin=${String(value.plugin)}`)
      const schemaVersion = value.database?.schemaVersion
      if (typeof schemaVersion !== "number" || schemaVersion <= 0) {
        throw new Error(`schemaVersion=${String(schemaVersion)}`)
      }
      const dbPath = value.database?.path ?? ""
      const dataDir = paths.get("data") ?? ""
      if (!inside(dbPath, path.join(dataDir, "projects"))) {
        throw new Error(`database.path is not under <data>/projects: ${dbPath} (data=${dataDir})`)
      }
      if (expectedChannel !== undefined && value.host?.channel !== expectedChannel) {
        throw new Error(`host.channel=${String(value.host?.channel)} (expected ${expectedChannel})`)
      }
      // Non-stable channels (dev canary) must not open the stable project DB.
      const stable = ["latest", "beta", "prod"]
      if (expectedChannel !== undefined && !stable.includes(expectedChannel)) {
        const name = path.basename(dbPath)
        if (!name.endsWith(`-${expectedChannel}.db`)) {
          throw new Error(`dev channel project DB is not channel-isolated: ${dbPath}`)
        }
      }
      return `plugin=banyancode schema=${schemaVersion} channel=${value.host?.channel} db=${path.basename(dbPath)}`
    })

    // -------------------------------------------------------- 7. namespaces
    await namespaceCheck("codegraph", () => rpc(url, "banyancode.codegraph", "status", {}))
    await namespaceCheck("intel", () => rpc(url, "banyancode.intel", "symbols", { query: "main", limit: 5 }))
    // verify has no cheap method (typecheck/test/lint all run processes), so
    // probe with an unknown method: `rpc.method_not_found` proves the
    // namespace is registered, `rpc.unavailable` proves it is not.
    await namespaceCheck("verify", () => rpc(url, "banyancode.verify", "__smoke_probe__", {}))
    await namespaceCheck("mesh", () => rpc(url, "banyancode.mesh", "limits.get", {}))
    await namespaceCheck("usage", () => rpc(url, "banyancode.usage", "toolUsage", {}))
    await namespaceCheck("system", () => rpc(url, "banyancode.system", "yolo.get", {}))

    // -------------------------------------------------- 8. codegraph build
    await check("codegraph build (embedded tree-sitter grammars)", async () => {
      const started = await rpc(url, "banyancode.codegraph", "build", { root: projectDir, force: true }, 120_000)
      const startedError = rpcError(started)
      if (started.status !== 200) {
        throw new Error(`build failed: HTTP ${started.status} ${startedError ?? tail(started.text, "", 4)}`)
      }
      const deadline = Date.now() + buildTimeout
      let state = output(started, "build") as Record<string, unknown>
      // `build` returns a BuildState; `status` returns the wider StatusOutput
      // (`{build, readiness, autoUpdate, meta, ...}`), so poll the nested state.
      // Wait for OUR root: a background bootstrap for another location must not
      // make this build look finished.
      while (Date.now() < deadline) {
        const running = String(state.status ?? "") === "running"
        const root = typeof state.root === "string" ? norm(state.root) : undefined
        if (!running && root === norm(projectDir)) break
        await delay(500)
        const polled = output(await rpc(url, "banyancode.codegraph", "status", {}, 60_000), "status") as {
          build?: Record<string, unknown>
        }
        state = polled.build ?? {}
      }
      // The build service reports "completed" before the sequencing fiber has
      // persisted the final graph meta; reading graph pages in that window races
      // the writer. Wait for the meta row, which is the durable "done" marker.
      while (Date.now() < deadline) {
        const meta = (state.meta ?? {}) as { totalNodes?: number }
        if (state.status === "completed" && (meta.totalNodes ?? 0) > 0) break
        await delay(250)
        const polled = output(await rpc(url, "banyancode.codegraph", "status", {}, 60_000), "status") as {
          build?: Record<string, unknown>
          meta?: { totalNodes?: number }
        }
        state = { ...(polled.build ?? {}), meta: polled.meta }
      }
      const finalStatus = String(state.status ?? "")
      if (finalStatus !== "completed") {
        throw new Error(`build status=${finalStatus} error=${String(state.error ?? "none")}`)
      }
      const result = (state.result ?? {}) as { indexed?: number; symbolsIndexed?: number; parseFailure?: number }
      if (!result.indexed || result.indexed <= 0) throw new Error("no files indexed")
      if (!result.symbolsIndexed || result.symbolsIndexed <= 0) throw new Error("no symbols indexed")

      const parseErrors = (state.parseErrors ?? []) as Array<{ path?: string; cause?: string }>
      const syntax = parseErrors.find((entry) => (entry.path ?? "").replaceAll("\\", "/").endsWith("broken.ts"))
      if (!syntax) throw new Error(`broken.ts produced no parse error (tree-sitter did not run): ${JSON.stringify(parseErrors)}`)
      const cause = syntax.cause ?? ""
      if (cause.includes("tree-sitter unavailable")) {
        throw new Error(`tree-sitter wasm unavailable, fell back to regex: ${cause}`)
      }
      if (!cause.includes("tree-sitter syntax error at line")) {
        throw new Error(`not a tree-sitter syntax error: ${cause}`)
      }

      const meta = (state.meta ?? {}) as { totalNodes?: number; totalEdges?: number; totalFiles?: number }
      if ((meta.totalNodes ?? 0) <= 0) throw new Error("graph meta reports no indexed nodes")
      // A page larger than the graph has no cursor: the response must still encode as strict JSON.
      const page = output(await rpc(url, "banyancode.codegraph", "nodes", { limit: 1000 }), "codegraph.nodes") as {
        nodes?: unknown[]
      }
      if (page.nodes?.length !== meta.totalNodes) {
        throw new Error(`codegraph.nodes returned ${page.nodes?.length} nodes, meta reports ${meta.totalNodes}`)
      }
      return (
        `indexed=${result.indexed} symbols=${result.symbolsIndexed} nodes=${meta.totalNodes} ` +
        `files=${meta.totalFiles ?? 0} parseFailure=${result.parseFailure ?? 0} syntax="${cause}"`
      )
    })

    // -------------------------------------------------- 9. project config
    await check("project banyancode.json honoured", async () => {
      const response = await rpc(url, "banyancode", "config.get", {})
      const value = output(response) as {
        config?: { banyancode_max_subagents?: number }
        sources?: string[]
      }
      const sources = (value.sources ?? []).map((source) => norm(source))
      const projectFile = norm(path.join(projectDir, "banyancode.json"))
      if (!sources.includes(projectFile)) {
        throw new Error(`project config missing from sources: ${sources.join(", ")}`)
      }
      if (value.config?.banyancode_max_subagents !== 3) {
        throw new Error(`banyancode_max_subagents=${String(value.config?.banyancode_max_subagents)} (expected 3)`)
      }
      return `sources=${sources.map((source) => path.basename(source)).join(",")} max_subagents=3`
    })

    // ------------------------------------------- 10. OPENCODE_CONFIG_DIR
    await check("OPENCODE_CONFIG_DIR ignored", async () => {
      const configPath = paths.get("config") ?? ""
      const expectedConfig = path.join(homeDir, ".config", "banyancode")
      if (norm(configPath) !== norm(expectedConfig)) {
        throw new Error(`config path=${configPath}; expected ${expectedConfig} (decoy ${decoyConfigDir})`)
      }
      const sources = (status.config?.sources ?? []).map((source) => norm(source))
      const leaked = sources.filter((source) => inside(source, decoyConfigDir))
      if (leaked.length > 0) throw new Error(`decoy config read: ${leaked.join(", ")}`)
      return `config=${configPath}`
    })

    // ------------------------------------------------------------- 11. mcp
    await check("mcp serve (initialize + tools/list)", async () => {
      const proc = Bun.spawn(
        [binary, "mcp", "serve", "--attach", url, "--password", password, "--no-start", "--cwd", projectDir],
        {
          cwd: projectDir,
          env: childEnv({ BANYANCODE_SERVER_PASSWORD: password }),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      let stderr = ""
      void new Response(proc.stderr)
        .text()
        .then((text) => {
          stderr = text
        })
        .catch(() => undefined)
      const lines: string[] = []
      let buffer = ""
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      const watchdog = setTimeout(() => proc.kill(), 60_000)
      try {
        proc.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "banyancode-smoke", version: "0.0.0" },
            },
          })}\n`,
        )
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`)
        proc.stdin.flush()
        let initialized = false
        let tools: Array<{ name?: string }> | undefined
        while (tools === undefined || !initialized) {
          const read = await reader.read()
          if (read.done) break
          buffer += decoder.decode(read.value, { stream: true })
          let newline = buffer.indexOf("\n")
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line !== "") lines.push(line)
            newline = buffer.indexOf("\n")
          }
          for (const line of lines) {
            let message: {
              id?: number
              result?: { serverInfo?: { name?: string }; tools?: Array<{ name?: string }> }
            }
            try {
              message = JSON.parse(line) as typeof message
            } catch {
              // Non-JSON stdout means the CLI never entered the MCP stdio
              // server (e.g. `mcp serve` is not wired yet and the CLI printed
              // its usage). Keep the line for the failure detail.
              continue
            }
            if (message.id === 1) initialized = true
            if (message.id === 2) tools = message.result?.tools
          }
        }
        if (!initialized || tools === undefined) {
          const code = proc.exitCode ?? (await Promise.race([proc.exited, delay(1_000).then(() => "running" as const)]))
          throw new Error(
            `no initialize/tools-list response (exit=${String(code)})\n${tail(lines.join("\n"), stderr)}`,
          )
        }
        if (tools.length === 0) throw new Error("tools/list returned an empty tool set")
        const names = tools.map((tool) => tool.name ?? "").filter(Boolean)
        const banyan = names.filter((name) => name.startsWith("banyan_"))
        if (banyan.length === 0) throw new Error(`no banyan_* tools in tools/list: ${names.join(", ")}`)
        return `${tools.length} tools, ${banyan.length} banyan_* (${banyan.slice(0, 3).join(", ")})`
      } finally {
        clearTimeout(watchdog)
        await stop(proc)
      }
    })

    // ------------------------------------------- 12. stock OpenCode dirs
    await check("stock OpenCode dirs untouched", async () => {
      const changes = [
        ...diffSnapshot(stockBefore.config, await snapshot(stockConfigDir)).map((change) => `.config/opencode/${change}`),
        ...diffSnapshot(stockBefore.dotDir, await snapshot(stockHomeDotDir)).map((change) => `.opencode/${change}`),
      ]
      if (changes.length > 0) throw new Error(`stock OpenCode paths changed:\n${changes.join("\n")}`)
      const decoyChanges = diffSnapshot(decoyBefore, await snapshot(decoyConfigDir))
      if (decoyChanges.length > 0) throw new Error(`OPENCODE_CONFIG_DIR was written:\n${decoyChanges.join("\n")}`)
      return "no reads/writes under ~/.config/opencode or ~/.opencode"
    })
  }
} finally {
  if (server !== undefined) await stop(server.proc)
}

async function namespaceCheck(name: string, call: () => Promise<RpcResponse>): Promise<void> {
  await check(`rpc banyancode.${name}`, async () => {
    const response = await call()
    const type = rpcError(response)
    if (response.status === 200) {
      return "wired"
    }
    // A registered namespace answers an unknown method with
    // `rpc.method_not_found`; an unregistered one with `rpc.unavailable`.
    if (type === "rpc.method_not_found") return "wired (probe method not found, namespace registered)"
    if (type === "rpc.invalid_input") return "wired (input rejected by a registered method)"
    if (type === "rpc.unavailable") throw new Error("not wired yet: rpc.unavailable (namespace not registered)")
    throw new Error(`HTTP ${response.status}: ${type ?? tail(response.text, "", 4)}`)
  })
}

failed = results.some((result) => result.status === "FAIL")

const width = Math.max(...results.map((result) => result.name.length))
console.log("")
console.log("BanyanCode smoke")
console.log(`  binary: ${binary}`)
console.log(`  root:   ${root}`)
console.log("")
for (const result of results) {
  console.log(`${result.status === "PASS" ? "PASS" : "FAIL"}  ${result.name.padEnd(width)}  ${result.detail.replaceAll("\n", "\n      ")}`)
}
const passed = results.filter((result) => result.status === "PASS").length
const failedCount = results.length - passed
console.log("")
console.log(`${passed} passed, ${failedCount} failed`)

if (keep) {
  console.log(`kept isolated root: ${root}`)
} else {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.exit(failed ? 1 : 0)
