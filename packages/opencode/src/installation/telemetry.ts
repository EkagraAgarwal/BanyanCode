import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { Probe, findAllBanyanCodeInstalls } from "./probe"

// Privacy contract (specs/banyancode/install-telemetry.md): the ping payload
// carries only a random install_id plus build/runtime facts. No hostname, no
// username, no filesystem path, no project/model/provider/prompt data, no MAC
// or device identifiers. Source IP is discarded at the edge.

const INSTALL_FILE = "install.json"
const RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000
export const TELEMETRY_ENDPOINT = process.env.BANYANCODE_TELEMETRY_ENDPOINT ?? "https://telemetry.banyan.dev"

export type TelemetrySetting = "on" | "off"
export type InstallMethod = "npm" | "pnpm" | "bun" | "homebrew" | "standalone" | "source" | "unknown"
export type PingOutcome = "disabled" | "idle" | "fired"

export interface InstallTelemetryState {
  last_attempt?: string
  last_success?: string
}

export interface InstallIdentity {
  install_id: string
  telemetry: InstallTelemetryState
}

export interface PingPayload {
  install_id: string
  version: string
  channel: string
  os: string
  arch: string
  install_method: InstallMethod
  ci: boolean
}

export function shouldPing(identity: InstallIdentity | undefined, now: number) {
  if (!identity) return true
  if (identity.telemetry.last_success) return false
  const lastAttempt = identity.telemetry.last_attempt
  if (!lastAttempt) return true
  const parsed = Date.parse(lastAttempt)
  if (Number.isNaN(parsed)) return true
  return now - parsed >= RETRY_INTERVAL_MS
}

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env, setting?: TelemetrySetting) {
  if (env.BANYANCODE_TELEMETRY === "off") return false
  if (env.DO_NOT_TRACK === "1") return false
  if (setting === "off") return false
  return true
}

export function isCI(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.CIRCLECI || env.TRAVIS)
}

export function mapInstallMethod(installs: Probe.BanyanInstall[]): InstallMethod {
  const install = installs[0]
  if (!install) return InstallationChannel === "local" ? "source" : "unknown"
  switch (install.method) {
    case "npm":
    case "yarn":
      return "npm"
    case "pnpm":
      return "pnpm"
    case "bun":
      return "bun"
    case "brew":
      return "homebrew"
    case "curl":
    case "scoop":
    case "choco":
    case "snap":
      return "standalone"
    default:
      return "unknown"
  }
}

export async function readInstallIdentity(stateDir: string) {
  const content = await fs.readFile(path.join(stateDir, INSTALL_FILE), "utf8").catch(() => undefined)
  if (!content) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Partial<InstallIdentity>
    if (typeof record.install_id !== "string") return undefined
    const telemetry = record.telemetry
    const state: InstallTelemetryState = {}
    if (telemetry && typeof telemetry.last_attempt === "string") state.last_attempt = telemetry.last_attempt
    if (telemetry && typeof telemetry.last_success === "string") state.last_success = telemetry.last_success
    return { install_id: record.install_id, telemetry: state }
  } catch {
    return undefined
  }
}

export async function writeInstallIdentity(stateDir: string, identity: InstallIdentity) {
  await fs.mkdir(stateDir, { recursive: true })
  await fs.writeFile(path.join(stateDir, INSTALL_FILE), JSON.stringify(identity, null, 2))
}

export async function readTelemetrySetting(configDir: string): Promise<TelemetrySetting | undefined> {
  const content = await fs.readFile(path.join(configDir, "banyancode.json"), "utf8").catch(() => undefined)
  if (!content) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const value = (parsed as Record<string, unknown>).banyancode_telemetry
    return value === "on" || value === "off" ? value : undefined
  } catch {
    return undefined
  }
}

export async function buildPayload(
  identity: InstallIdentity,
  env: NodeJS.ProcessEnv = process.env,
  probeInstalls?: () => Promise<Probe.BanyanInstall[]>,
): Promise<PingPayload> {
  const installs = await (probeInstalls ?? (() => findAllBanyanCodeInstalls()))().catch(() => [])
  return {
    install_id: identity.install_id,
    version: InstallationVersion,
    channel: InstallationChannel,
    os: process.platform,
    arch: process.arch,
    install_method: mapInstallMethod(installs),
    ci: isCI(env),
  }
}

export interface PingTransportOptions {
  fetchImpl?: typeof fetch
  endpoint?: string
  signal?: AbortSignal
}

export async function ping(payload: PingPayload, options: PingTransportOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.endpoint ?? TELEMETRY_ENDPOINT
  const signal = options.signal ?? AbortSignal.timeout(3000)
  try {
    const response = await fetchImpl(`${endpoint}/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
    return response.ok
  } catch {
    console.debug("[banyancode] install telemetry ping failed")
    return false
  }
}

export interface PingOptions extends PingTransportOptions {
  stateDir?: string
  configDir?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  probeInstalls?: () => Promise<Probe.BanyanInstall[]>
}

export async function pingOnFirstRun(options: PingOptions = {}): Promise<PingOutcome> {
  const stateDir = options.stateDir ?? Global.Path.banyan.state
  const env = options.env ?? process.env
  const setting = await readTelemetrySetting(options.configDir ?? Global.Path.banyan.config)
  if (!telemetryEnabled(env, setting)) return "disabled"
  const identity = (await readInstallIdentity(stateDir)) ?? { install_id: randomUUID(), telemetry: {} }
  if (!shouldPing(identity, (options.now ?? Date.now)())) return "idle"
  const attempted: InstallIdentity = {
    ...identity,
    telemetry: { ...identity.telemetry, last_attempt: new Date().toISOString() },
  }
  await writeInstallIdentity(stateDir, attempted).catch(() => {})
  const payload = await buildPayload(attempted, env, options.probeInstalls)
  const ok = await ping(payload, options)
  if (ok) {
    const succeeded: InstallIdentity = {
      ...attempted,
      telemetry: { ...attempted.telemetry, last_success: new Date().toISOString() },
    }
    await writeInstallIdentity(stateDir, succeeded).catch(() => {})
  }
  return "fired"
}

export * as Telemetry from "./telemetry"
