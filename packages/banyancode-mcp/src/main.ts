// Entry point for `banyancode mcp` (and the minimal CLI wiring:
// `handler: (argv) => main(argv)`). Kept dependency-free of the CLI package so
// this can ship before the subcommand lands and be unit-tested directly.

import path from "node:path"
import { McpConfig, type ResolvedConfig } from "./config"
import { assertYoloAllowed, listProfiles } from "./autonomy"
import { attachOrStart, resolveServeCommand, selfCommand } from "./attach"
import { createSessionPort, makeRpcCaller } from "./session-client"
import { TaskEngine } from "./engine"
import { createMcpServer } from "./server"
import { serveStdio } from "./transport-stdio"
import { serveHttp } from "./transport-http"
import { applyInstall, describePlan, isInstallClient, planInstall, InstallClients, type InstallClient } from "./install"
import { Service } from "@opencode/client/service"
import { log } from "./logging"

export type MainIO = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  cwd: () => string
  env: NodeJS.ProcessEnv
  /** Ask a yes/no question. Defaults to a stdin prompt; tests inject it. */
  prompt?: (question: string) => Promise<boolean>
}

// One line from stdin, re-asked on empty input. Anything but y/yes is "no".
const readConfirm = async (question: string): Promise<boolean> => {
  process.stderr.write(`${question} [y/N] `)
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return false
      buffer += decoder.decode(value, { stream: true })
      const newline = buffer.indexOf("\n")
      if (newline === -1) continue
      return /^y(es)?$/i.test(buffer.slice(0, newline).trim())
    }
  } finally {
    reader.releaseLock()
  }
}

const defaultIO: MainIO = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  cwd: () => process.cwd(),
  env: process.env,
  prompt: readConfirm,
}

type Parsed = {
  command: string
  positional: string[]
  flags: Map<string, string | boolean>
}

const BOOLEAN_FLAGS = new Set(["allow-yolo", "http", "no-start", "no-rehydrate", "help", "json", "yes"])

export function parseArgv(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  let command: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--") {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith("--")) {
      if (command === undefined) command = arg
      else positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const equals = body.indexOf("=")
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags.set(body, true)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next)
      index += 1
      continue
    }
    flags.set(body, true)
  }
  return { command: command ?? "serve", positional, flags }
}

const flagString = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags.get(name)
  return typeof value === "string" ? value : undefined
}

const flagBoolean = (parsed: Parsed, name: string) => parsed.flags.get(name) === true

const HELP = `banyancode mcp — BanyanCode MCP delegation server

Usage:
  banyancode mcp [serve] [options]        serve over stdio (default)
  banyancode mcp serve --http             serve over stateless Streamable HTTP
  banyancode mcp doctor                   check config, service and task state
  banyancode mcp profiles                 list autonomy profiles
  banyancode mcp install <client> [--yes] write the client config (claude-code|codex|cursor)

Options:
  --cwd <dir>          project directory the tasks run in (default: $CLAUDE_PROJECT_DIR or cwd)
  --config <file>      banyancode.json path (default: discovery from --cwd)
  --attach <url>       reuse a running server instead of discovering/starting one
  --password <pw>      password for --attach (default: $BANYANCODE_SERVER_PASSWORD)
  --no-start           never spawn the background service
  --allow-yolo         permit the yolo autonomy profile (stored config cannot)
  --permission <p>     reject | edits | yolo (overrides stored permission)
  --max-tasks <n>      max concurrent delegated tasks (1-32)
  --tools <groups>     comma-separated tool groups (default: all; "task", "code")
  --http               Streamable HTTP instead of stdio
  --port <n>           HTTP port (default: ephemeral)
  --hostname <host>    HTTP bind (default 127.0.0.1; non-loopback needs --token)
  --token <token>      HTTP bearer token (default: $BANYANCODE_MCP_TOKEN, else generated)
  --no-rehydrate       skip rebuilding task handles from sessions at startup
  --yes                install: write without asking (prints the change first)

Environment:
  BANYANCODE_CONFIG, BANYANCODE_CONFIG_DIR   config discovery
  BANYANCODE_SERVER_PASSWORD                 password for --attach
  BANYANCODE_BIN                             binary for the background service (default: this binary)
  BANYANCODE_MCP_SERVE_COMMAND               full serve command override
  BANYANCODE_MCP_ALLOW_YOLO=1                same as --allow-yolo
  BANYANCODE_MCP_TOKEN                       HTTP bearer token
  BANYANCODE_MCP_KILL=1                      runtime kill switch: every tool call fails
`

const installClients = InstallClients.join("|")

const toolGroups = (parsed: Parsed): string[] | undefined => {
  const raw = flagString(parsed, "tools")
  if (raw === undefined) return undefined
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

const resolve = (parsed: Parsed, io: MainIO): ResolvedConfig => {
  const cwd = path.resolve(flagString(parsed, "cwd") ?? io.env["CLAUDE_PROJECT_DIR"] ?? io.cwd())
  const config = McpConfig.resolveConfig({
    cwd,
    ...(flagString(parsed, "config") !== undefined ? { configPath: flagString(parsed, "config")! } : {}),
    allowYolo: flagBoolean(parsed, "allow-yolo"),
    ...(flagString(parsed, "permission") !== undefined
      ? { permission: flagString(parsed, "permission") as "reject" | "edits" | "yolo" }
      : {}),
    ...(flagString(parsed, "max-tasks") !== undefined
      ? { maxConcurrentTasks: Number(flagString(parsed, "max-tasks")) }
      : {}),
    ...(toolGroups(parsed) !== undefined ? { toolGroups: toolGroups(parsed)! } : {}),
    env: io.env,
  })
  assertYoloAllowed(flagBoolean(parsed, "allow-yolo") || McpConfig.readAllowYoloEnv(io.env), config.permission)
  return config
}

const write = (io: MainIO, value: unknown): void => {
  io.stdout(JSON.stringify(value, null, 2))
}

async function serve(parsed: Parsed, io: MainIO): Promise<number> {
  const cwd = path.resolve(flagString(parsed, "cwd") ?? io.env["CLAUDE_PROJECT_DIR"] ?? io.cwd())
  const config = resolve(parsed, io)
  const target = await attachOrStart({
    ...(flagString(parsed, "attach") !== undefined ? { attach: flagString(parsed, "attach")! } : {}),
    ...(flagString(parsed, "password") !== undefined ? { password: flagString(parsed, "password")! } : {}),
    noStart: flagBoolean(parsed, "no-start"),
    ...(flagString(parsed, "service-file") !== undefined ? { serviceFile: flagString(parsed, "service-file")! } : {}),
    envVars: io.env,
    onStart: (reason) => log(`starting the background service (${reason})`),
  })
  log(`attached to ${target.url} (${target.mode})`)
  const port = createSessionPort({
    baseUrl: target.baseUrl,
    ...(target.headers !== undefined ? { headers: target.headers } : {}),
    root: cwd,
  })
  const rpc = makeRpcCaller({
    baseUrl: target.baseUrl,
    ...(target.headers !== undefined ? { headers: target.headers } : {}),
    root: cwd,
  })
  const engine = new TaskEngine({ port, config, root: cwd })
  if (!flagBoolean(parsed, "no-rehydrate")) {
    const restored = await engine.rehydrateAll().catch(() => [])
    if (restored.length > 0) log(`rehydrated ${restored.length} task(s) from session metadata`)
  }
  const groups = toolGroups(parsed) ?? config.toolGroups
  const bootstrap = createMcpServer({
    engine,
    config,
    root: cwd,
    rpc,
    ...(groups !== undefined ? { toolGroups: groups } : {}),
  })
  const shutdown = async () => {
    engine.close()
    await bootstrap.close().catch(() => undefined)
  }
  if (flagBoolean(parsed, "http")) {
    // The HTTP entry builds a server per request; the engine is shared.
    await serveHttp({
      create: () =>
        createMcpServer({
          engine,
          config,
          root: cwd,
          rpc,
          ...(groups !== undefined ? { toolGroups: groups } : {}),
          watchTransitions: false,
        }).mcp,
      ...(flagString(parsed, "port") !== undefined ? { port: Number(flagString(parsed, "port")) } : {}),
      ...(flagString(parsed, "hostname") !== undefined ? { hostname: flagString(parsed, "hostname")! } : {}),
      ...(flagString(parsed, "token") !== undefined ? { token: flagString(parsed, "token")! } : {}),
      onShutdown: shutdown,
    })
    return 0
  }
  await serveStdio({ create: () => bootstrap, onShutdown: shutdown })
  return 0
}

async function doctor(parsed: Parsed, io: MainIO): Promise<number> {
  const cwd = path.resolve(flagString(parsed, "cwd") ?? io.env["CLAUDE_PROJECT_DIR"] ?? io.cwd())
  let config: ResolvedConfig | undefined
  let configError: string | undefined
  try {
    config = McpConfig.resolveConfig({ cwd, env: io.env })
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error)
  }
  const discovered = await Service.discover().catch(() => undefined)
  const report: Record<string, unknown> = {
    cwd,
    config_path: config?.configPath ?? null,
    permission: config?.permission ?? null,
    max_concurrent_tasks: config?.maxConcurrentTasks ?? null,
    tool_groups: config?.toolGroups ?? null,
    autonomy: config === undefined ? null : listProfiles(config.autonomy).map((profile) => profile.name),
    service: discovered === undefined ? null : { url: discovered.url, auth: discovered.auth !== undefined },
    serve_command: (() => {
      try {
        return resolveServeCommand(io.env)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })(),
    ok: configError === undefined,
  }
  if (configError !== undefined) report.error = configError
  if (discovered !== undefined && config !== undefined) {
    try {
      const port = createSessionPort({
        baseUrl: discovered.url,
        ...(Service.headers(discovered) !== undefined
          ? { headers: Service.headers(discovered) as Record<string, string> }
          : {}),
        root: cwd,
      })
      const engine = new TaskEngine({ port, config, root: cwd })
      const restored = await engine.rehydrateAll()
      report.tasks = restored.map((record) => ({
        task_id: record.handle,
        status: record.status,
        agent: record.agent,
        cost: record.cost,
      }))
      engine.close()
    } catch (error) {
      report.service_error = error instanceof Error ? error.message : String(error)
    }
  }
  write(io, report)
  return configError === undefined ? 0 : 1
}

async function install(parsed: Parsed, io: MainIO): Promise<number> {
  const requested = parsed.positional[0]
  if (requested === undefined) {
    io.stderr(`usage: banyancode mcp install <${installClients}> [--yes]`)
    return 2
  }
  if (!isInstallClient(requested)) {
    io.stderr(`unknown client "${requested}"; expected one of: ${installClients}`)
    return 2
  }
  const cwd = path.resolve(flagString(parsed, "cwd") ?? io.env["CLAUDE_PROJECT_DIR"] ?? io.cwd())
  const client: InstallClient = requested
  const plan = planInstall({ client, cwd, selfCommand: selfCommand(), env: io.env })
  io.stdout(`BanyanCode MCP install for ${client} (project: ${cwd})`)
  io.stdout(describePlan(plan))
  const pending = plan.files.filter((file) => file.changes)
  if (pending.length === 0) {
    io.stdout("nothing to write: the client config already matches")
    return 0
  }
  if (!flagBoolean(parsed, "yes")) {
    const ask = io.prompt
    if (ask === undefined) {
      io.stderr("not writing without confirmation; re-run with --yes")
      return 2
    }
    const approved = await ask(`Write ${pending.length} file(s)?`)
    if (!approved) {
      io.stderr("aborted; nothing written")
      return 2
    }
  }
  const written = applyInstall({
    ...plan,
    files: pending,
  })
  io.stdout(written.map((file) => `wrote ${file}`).join("\n"))
  if (client === "claude-code") {
    io.stdout("Restart Claude Code (or run /mcp) to pick up the server and the delegate skill.")
  } else {
    io.stdout("Restart the client to pick up the server.")
  }
  return 0
}

function profiles(parsed: Parsed, io: MainIO): number {
  const config = resolve(parsed, io)
  write(io, {
    default: config.autonomy.default ?? "supervised",
    auto_answer_after_seconds: config.autonomy.auto_answer_after_seconds,
    profiles: listProfiles(config.autonomy).map((profile) => ({
      name: profile.name,
      builtin: profile.builtin,
      description: profile.profile.description,
      rules: profile.profile.rules.length,
    })),
  })
  return 0
}

export async function main(argv: readonly string[] = process.argv.slice(2), overrides: Partial<MainIO> = {}): Promise<number> {
  const io: MainIO = { ...defaultIO, ...overrides }
  const parsed = parseArgv(argv)
  if (flagBoolean(parsed, "help") || parsed.command === "help") {
    io.stdout(HELP)
    return 0
  }
  try {
    switch (parsed.command) {
      case "serve":
        return await serve(parsed, io)
      case "doctor":
        return await doctor(parsed, io)
      case "profiles":
        return profiles(parsed, io)
      case "install":
        return await install(parsed, io)
      default:
        io.stderr(`unknown command "${parsed.command}"\n\n${HELP}`)
        return 2
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

export * as Main from "./main"
