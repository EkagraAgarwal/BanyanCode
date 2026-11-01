import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { VERSION } from "../version.js"

/**
 * Install telemetry, ported from v1
 * `packages/opencode/src/installation/telemetry.ts`.
 *
 * Privacy contract is unchanged: the ping carries a random install id plus
 * build/runtime facts only (no hostname, user, path, project, model, prompt or
 * device identifier). Source IP is discarded by PostHog at the edge.
 *
 * The PostHog key is baked into a release binary by the CLI build script
 * (`process.env.BANYANCODE_POSTHOG_KEY`). This module reads that exact
 * expression, so a build `define` (or a runtime env var in source builds)
 * works; with neither a key nor `BANYANCODE_TELEMETRY_ENDPOINT` the transport
 * is unavailable and the ping is a silent no-op. Tests always pass an explicit
 * `fetchImpl`/key or assert the no-op.
 */

const INSTALL_FILE = "install.json"
const RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export const POSTHOG_ENDPOINT = "https://us.i.posthog.com/i/v0/e/"
export const TELEMETRY_ENDPOINT = process.env.BANYANCODE_TELEMETRY_ENDPOINT

export type TelemetrySetting = "on" | "off"
export type InstallMethod = "npm" | "pnpm" | "bun" | "homebrew" | "standalone" | "source" | "unknown"
export type PingOutcome = "disabled" | "idle" | "noop" | "fired"
export type PingEvent = "first_run" | "heartbeat"

export interface InstallTelemetryState {
  readonly last_attempt?: string
  readonly last_success?: string
  readonly last_heartbeat?: string
}

export interface InstallIdentity {
  readonly install_id: string
  readonly telemetry: InstallTelemetryState
}

export interface PingPayload {
  readonly install_id: string
  readonly event_type: PingEvent
  readonly version: string
  readonly channel: string
  readonly os: string
  readonly arch: string
  readonly install_method: InstallMethod
  readonly ci: boolean
}

export const telemetryEnabled = (env: NodeJS.ProcessEnv = process.env, setting?: TelemetrySetting): boolean => {
  if (env.BANYANCODE_TELEMETRY === "off") return false
  if (env.DO_NOT_TRACK === "1") return false
  if (setting === "off") return false
  return true
}

export const isCI = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.CIRCLECI || env.TRAVIS)

/**
 * v1 probed every known install path. v2 only needs a coarse bucket for the
 * dashboard; the package manager user-agent is available when npm/bun runs a
 * lifecycle script, and source checkouts are recognisable from the entry path.
 */
export const detectInstallMethod = (
  env: NodeJS.ProcessEnv = process.env,
  entry: string | undefined = (import.meta as { dir?: string }).dir,
): InstallMethod => {
  const agent = env.npm_config_user_agent ?? ""
  if (agent.startsWith("bun/")) return "bun"
  if (agent.startsWith("pnpm/")) return "pnpm"
  if (agent.startsWith("npm/") || agent.startsWith("yarn/")) return "npm"
  if (entry !== undefined && /[\\/]packages[\\/]banyancode[\\/]/.test(entry)) return "source"
  return "unknown"
}

export const shouldPing = (identity: InstallIdentity | undefined, now: number): boolean => {
  if (identity === undefined) return true
  if (identity.telemetry.last_success !== undefined) return false
  const attempted = identity.telemetry.last_attempt
  if (attempted === undefined) return true
  const parsed = Date.parse(attempted)
  if (Number.isNaN(parsed)) return true
  return now - parsed >= RETRY_INTERVAL_MS
}

export const shouldHeartbeat = (identity: InstallIdentity | undefined, now: number): boolean => {
  if (identity === undefined) return false
  if (identity.telemetry.last_success === undefined) return false
  const last = identity.telemetry.last_heartbeat
  if (last === undefined) return true
  const parsed = Date.parse(last)
  if (Number.isNaN(parsed)) return true
  return now - parsed >= HEARTBEAT_INTERVAL_MS
}

export const readInstallIdentity = async (stateDir: string): Promise<InstallIdentity | undefined> => {
  const content = await readFile(join(stateDir, INSTALL_FILE), "utf8").catch(() => undefined)
  if (content === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Partial<InstallIdentity>
    if (typeof record.install_id !== "string") return undefined
    const telemetry = record.telemetry
    const state: InstallTelemetryState = {
      ...(typeof telemetry?.last_attempt === "string" ? { last_attempt: telemetry.last_attempt } : {}),
      ...(typeof telemetry?.last_success === "string" ? { last_success: telemetry.last_success } : {}),
      ...(typeof telemetry?.last_heartbeat === "string" ? { last_heartbeat: telemetry.last_heartbeat } : {}),
    }
    return { install_id: record.install_id, telemetry: state }
  } catch {
    return undefined
  }
}

export const writeInstallIdentity = async (stateDir: string, identity: InstallIdentity): Promise<void> => {
  await mkdir(dirname(join(stateDir, INSTALL_FILE)), { recursive: true })
  await writeFile(join(stateDir, INSTALL_FILE), JSON.stringify(identity, null, 2), "utf8")
}

export const buildPayload = (
  identity: InstallIdentity,
  options: {
    readonly version?: string
    readonly channel?: string
    readonly env?: NodeJS.ProcessEnv
    readonly eventType?: PingEvent
    readonly installMethod?: InstallMethod
  } = {},
): PingPayload => {
  const env = options.env ?? process.env
  return {
    install_id: identity.install_id,
    event_type: options.eventType ?? "first_run",
    version: options.version ?? VERSION,
    channel: options.channel ?? "latest",
    os: process.platform,
    arch: process.arch,
    install_method: options.installMethod ?? detectInstallMethod(env),
    ci: isCI(env),
  }
}

export interface PingTransportOptions {
  readonly fetchImpl?: typeof fetch
  readonly endpoint?: string
  readonly posthogKey?: string
  readonly signal?: AbortSignal
}

export const transportAvailable = (options: PingTransportOptions = {}): boolean =>
  Boolean(options.posthogKey ?? process.env.BANYANCODE_POSTHOG_KEY) ||
  Boolean(options.endpoint ?? process.env.BANYANCODE_TELEMETRY_ENDPOINT ?? TELEMETRY_ENDPOINT)

export const ping = async (payload: PingPayload, options: PingTransportOptions = {}): Promise<boolean> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = options.signal ?? AbortSignal.timeout(3_000)
  const posthogKey = options.posthogKey ?? process.env.BANYANCODE_POSTHOG_KEY
  const endpoint = options.endpoint ?? process.env.BANYANCODE_TELEMETRY_ENDPOINT ?? TELEMETRY_ENDPOINT
  if (!posthogKey && !endpoint) return false
  const { install_id, event_type, ...properties } = payload
  const body = posthogKey
    ? JSON.stringify({
        api_key: posthogKey,
        distinct_id: install_id,
        event: event_type === "heartbeat" ? "banyan_heartbeat" : "banyan_install",
        properties,
      })
    : JSON.stringify(payload)
  const url = posthogKey ? POSTHOG_ENDPOINT : `${endpoint}/ping`
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
    return response.ok
  } catch {
    console.debug("[banyancode] install telemetry ping failed")
    return false
  }
}

export interface PingOptions extends PingTransportOptions {
  readonly stateDir: string
  readonly setting?: TelemetrySetting
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  readonly version?: string
  readonly channel?: string
  readonly eventType?: PingEvent
}

const identityFor = async (stateDir: string): Promise<InstallIdentity> =>
  (await readInstallIdentity(stateDir)) ?? { install_id: randomUUID(), telemetry: {} }

/** First-run ping: at most one success ever, one retry attempt per 24h. */
export const pingOnFirstRun = async (options: PingOptions): Promise<PingOutcome> => {
  const env = options.env ?? process.env
  if (!telemetryEnabled(env, options.setting)) return "disabled"
  if (!transportAvailable(options)) return "noop"
  const identity = await identityFor(options.stateDir)
  const now = (options.now ?? Date.now)()
  if (!shouldPing(identity, now)) return "idle"
  const attempted: InstallIdentity = {
    ...identity,
    telemetry: { ...identity.telemetry, last_attempt: new Date(now).toISOString() },
  }
  await writeInstallIdentity(options.stateDir, attempted).catch(() => {})
  const payload = buildPayload(attempted, {
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    env,
    eventType: options.eventType ?? "first_run",
  })
  const ok = await ping(payload, options)
  if (ok) {
    const succeeded: InstallIdentity = {
      ...attempted,
      telemetry: { ...attempted.telemetry, last_success: new Date(now).toISOString() },
    }
    await writeInstallIdentity(options.stateDir, succeeded).catch(() => {})
  }
  return "fired"
}

/** Weekly heartbeat, only after a successful first run. */
export const heartbeat = async (options: PingOptions): Promise<PingOutcome> => {
  const env = options.env ?? process.env
  if (!telemetryEnabled(env, options.setting)) return "disabled"
  if (!transportAvailable(options)) return "noop"
  const identity = await readInstallIdentity(options.stateDir)
  const now = (options.now ?? Date.now)()
  if (identity === undefined || !shouldHeartbeat(identity, now)) return "idle"
  const payload = buildPayload(identity, {
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    env,
    eventType: "heartbeat",
  })
  const ok = await ping(payload, options)
  if (ok) {
    await writeInstallIdentity(options.stateDir, {
      ...identity,
      telemetry: { ...identity.telemetry, last_heartbeat: new Date(now).toISOString() },
    }).catch(() => {})
  }
  return "fired"
}
