// Attach to (or start) the BanyanCode background server.
//
// v2's service model: the CLI registers a small JSON file with the listening
// URL and a password; clients discover it, probe /api/server, and reuse it.
// `Service.discover` never spawns; `Service.ensure` spawns the configured
// command and waits for the registration to become healthy. Tasks therefore
// outlive the MCP client (stdio is only the control channel).

import { Service } from "@opencode/client/service"
import type { Endpoint } from "@opencode/client/service"
import path from "node:path"

export type AttachTarget = {
  baseUrl: string
  headers?: Record<string, string>
  /** "attach" = caller-provided URL, "service" = existing registration, "started" = we spawned it. */
  mode: "attach" | "service" | "started"
  url: string
}

export type AttachOptions = {
  /** Explicit server URL (--attach). */
  attach?: string
  /** Password for an attached URL (--password or BANYANCODE_SERVER_PASSWORD). */
  password?: string
  /** Refuse to spawn a background service (--no-start). */
  noStart?: boolean
  /** Registration file. The CLI passes its channel's file; dev and next builds don't share `service.json`. */
  serviceFile?: string
  /** Environment passed to the spawned service. */
  env?: Record<string, string>
  /** Reports the ensure reason before a spawn. */
  onStart?: (reason: "missing" | "version-mismatch") => void
  envVars?: NodeJS.ProcessEnv
}

export const SERVE_COMMAND_ENV = "BANYANCODE_MCP_SERVE_COMMAND" as const
export const BIN_ENV = "BANYANCODE_BIN" as const
export const PASSWORD_ENV = "BANYANCODE_SERVER_PASSWORD" as const

// The command that re-invokes THIS binary. Mirrors
// `packages/cli/src/util/process.ts: selfCommand`: a compiled binary executes
// itself; a script run under bun/node executes the interpreter with the CLI
// entrypoint. A bare `opencode` is never used — that may be the upstream binary
// or nothing at all.
const ENTRYPOINT = process.argv[1] ? path.resolve(process.argv[1]) : undefined

export function selfCommand(): string[] {
  const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  if (runtime !== "bun" && runtime !== "node" && runtime !== "nodejs") return [process.execPath]
  if (ENTRYPOINT === undefined) {
    throw new Error(
      "cannot resolve the CLI entrypoint for the background service; set BANYANCODE_BIN or BANYANCODE_MCP_SERVE_COMMAND",
    )
  }
  if (runtime === "node" || runtime === "nodejs") return [process.execPath, ...nodeFlags(), ENTRYPOINT]
  return [process.execPath, ENTRYPOINT]
}

function nodeFlags(): string[] {
  return process.execArgv.flatMap((arg, index, args) => {
    if (index > 0 && args[index - 1] === "--conditions") return []
    if (arg === "--conditions") return args[index + 1] ? [arg, args[index + 1]] : []
    if (arg.startsWith("--conditions=")) return [arg]
    if (
      arg === "--experimental-ffi" ||
      arg === "--use-system-ca" ||
      arg === "--enable-source-maps" ||
      arg === "--no-addons"
    ) {
      return [arg]
    }
    if (arg === "--no-warnings" || arg.startsWith("--disable-warning=")) return [arg]
    return []
  })
}

export function resolveServeCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env[SERVE_COMMAND_ENV]
  if (explicit !== undefined && explicit.trim() !== "") return splitCommand(explicit)
  const bin = env[BIN_ENV]
  if (bin !== undefined && bin.trim() !== "") return [bin, "serve", "--service"]
  return [...selfCommand(), "serve", "--service"]
}

function splitCommand(raw: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (const char of raw) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === " ") {
      if (current !== "") parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current !== "") parts.push(current)
  return parts
}

// Basic auth headers for a manually attached server. v2's server compares the
// username against `opencode` (ServerAuth.Config is seeded with it) before the
// password, so the username is NOT free-form. Revisit with the branding rename.
export const SERVER_USERNAME = "opencode" as const

export function basicAuthHeaders(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64")}` }
}

const endpointTarget = (endpoint: Endpoint, mode: AttachTarget["mode"]): AttachTarget => {
  const headers = Service.headers(endpoint) as Record<string, string> | undefined
  return {
    baseUrl: endpoint.url,
    ...(headers !== undefined ? { headers } : {}),
    mode,
    url: endpoint.url,
  }
}

export async function attachOrStart(options: AttachOptions = {}): Promise<AttachTarget> {
  const env = options.envVars ?? process.env
  if (options.attach !== undefined && options.attach !== "") {
    const password = options.password ?? env[PASSWORD_ENV]
    return {
      baseUrl: normalizeUrl(options.attach),
      ...(password !== undefined && password !== "" ? { headers: basicAuthHeaders(password) } : {}),
      mode: "attach",
      url: normalizeUrl(options.attach),
    }
  }
  const discoverOptions = options.serviceFile !== undefined ? { file: options.serviceFile } : {}
  const found = await Service.discover(discoverOptions)
  if (found !== undefined) return endpointTarget(found, "service")
  if (options.noStart === true) {
    throw new Error(
      "no BanyanCode background service is running and --no-start was passed; " +
        "start one with `banyancode serve --service` or pass --attach <url>",
    )
  }
  options.onStart?.("missing")
  const endpoint = await Service.ensure({
    ...discoverOptions,
    command: resolveServeCommand(env),
    ...(options.env !== undefined ? { env: options.env } : {}),
  })
  return endpointTarget(endpoint, "started")
}

const normalizeUrl = (url: string): string => {
  const trimmed = url.replace(/\/+$/, "")
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export * as Attach from "./attach"
