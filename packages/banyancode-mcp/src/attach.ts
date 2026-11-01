// Attach to (or start) the BanyanCode background server.
//
// v2's service model: the CLI registers a small JSON file with the listening
// URL and a password; clients discover it, probe /api/server, and reuse it.
// `Service.discover` never spawns; `Service.ensure` spawns the configured
// command and waits for the registration to become healthy. Tasks therefore
// outlive the MCP client (stdio is only the control channel).

import { Service } from "@opencode/client/service"
import type { Endpoint } from "@opencode/client/service"

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
  /** Registration file override (tests). */
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

// v2-base still ships upstream branding, so the default binary is `opencode`.
// When the BanyanCode rename lands, set BANYANCODE_BIN=banyancode (or this
// default changes with it).
export function resolveServeCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env[SERVE_COMMAND_ENV]
  if (explicit !== undefined && explicit.trim() !== "") return splitCommand(explicit)
  const bin = env[BIN_ENV]
  if (bin !== undefined && bin.trim() !== "") return [bin, "serve", "--service"]
  return ["opencode", "serve", "--service"]
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
        "start one with `opencode serve --service` or pass --attach <url>",
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
