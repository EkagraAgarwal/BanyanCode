export * as ClaudeRateLimits from "./rate-limits.js"

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { Global } from "@opencode/util/global"

/**
 * Claude Code plan utilization observed from the Agent SDK stream.
 *
 * The SDK emits `rate_limit_event` whenever Claude Code learns new plan
 * limits. Those events are the only credential-free source the Claude Agent
 * provider has (the login belongs to the `claude` CLI), so the sidebar reads
 * this store instead of probing Claude's files or tokens. The last observation
 * is also persisted as numbers in the data directory, so a service restart
 * keeps the bars until the next response. Values are reported verbatim — a
 * missing utilization stays missing.
 */

export interface Window {
  readonly id: string
  readonly label: string
  readonly usedPercent?: number
  readonly resetsAt?: number
  readonly durationSeconds?: number
}

export interface Observation {
  readonly windows: ReadonlyArray<Window>
  readonly observedAt: number
}

const DEFINITIONS = {
  five_hour: { label: "5h", durationSeconds: 18_000 },
  seven_day: { label: "1w", durationSeconds: 604_800 },
  seven_day_opus: { label: "Opus 1w", durationSeconds: 604_800 },
  seven_day_sonnet: { label: "Sonnet 1w", durationSeconds: 604_800 },
  seven_day_oauth_apps: { label: "OAuth Apps 1w", durationSeconds: 604_800 },
} as const

type WindowID = keyof typeof DEFINITIONS

// Newer CLIs put the same window shape under `unifiedWindows`; the SDK types
// this release does not declare it yet.
interface UnifiedWindow {
  readonly utilization?: number | null
  readonly resetsAt?: number | null
}

interface RateLimitInfo extends SDKRateLimitInfo {
  readonly unifiedWindows?: Readonly<Record<string, UnifiedWindow | null | undefined>>
}

const ORDER: Record<string, number> = {
  five_hour: 0,
  seven_day: 1,
  seven_day_opus: 2,
  seven_day_sonnet: 3,
  seven_day_oauth_apps: 4,
}

// Build-time channel, the same define the CLI reads.
declare const OPENCODE_CHANNEL: string

const STABLE_CHANNELS = new Set(["latest", "beta", "prod"])
const embeddedChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"

/** One JSON file per channel so a dev build never overwrites stable observations. */
export const storeFileName = (channel: string, env: NodeJS.ProcessEnv = process.env): string => {
  const stable =
    STABLE_CHANNELS.has(channel) ||
    env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  if (stable || channel.length === 0) return "claude-agent-rate-limits.json"
  return `claude-agent-rate-limits-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
}

const defaultFilePath = () => {
  const channel = process.env.OPENCODE_CHANNEL
  return join(
    Global.Path.data,
    storeFileName(channel !== undefined && channel.length > 0 ? channel : embeddedChannel),
  )
}

const windows = new Map<string, Window>()
let observedAt = 0
let storePath: string | undefined
let loaded = false
let writeSequence = 0

const definition = (id: string) =>
  DEFINITIONS[id as WindowID] ?? { label: id.replaceAll("_", " "), durationSeconds: undefined }

/**
 * `bun test` sets NODE_ENV=test. Without an injected path the suite must not
 * read or write the real profile; persistence tests inject a tmp file.
 */
const filePath = (): string | undefined =>
  storePath ?? (process.env.NODE_ENV === "test" ? undefined : defaultFilePath())

/** Rebuild one persisted observation; the file stores numbers only. */
const restore = (id: string, percent: unknown, reset: unknown): boolean => {
  const used =
    typeof percent === "number" && Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : undefined
  const resetAt =
    typeof reset === "number" && Number.isFinite(reset) && reset > 0 ? Math.round(reset) : undefined
  if (used === undefined && resetAt === undefined) return false
  const window = definition(id)
  windows.set(id, {
    id,
    label: window.label,
    ...(window.durationSeconds === undefined ? {} : { durationSeconds: window.durationSeconds }),
    ...(used === undefined ? {} : { usedPercent: used }),
    ...(resetAt === undefined ? {} : { resetsAt: resetAt }),
  })
  return true
}

const load = (): void => {
  loaded = true
  const file = filePath()
  if (file === undefined) return
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return
    const state = parsed as { readonly observedAt?: unknown; readonly windows?: unknown }
    if (!Array.isArray(state.windows)) return
    const at =
      typeof state.observedAt === "number" && Number.isFinite(state.observedAt) && state.observedAt > 0
        ? Math.round(state.observedAt)
        : 0
    let restored = false
    for (const entry of state.windows) {
      if (typeof entry !== "object" || entry === null) continue
      const raw = entry as { readonly id?: unknown; readonly usedPercent?: unknown; readonly resetsAt?: unknown }
      if (typeof raw.id !== "string" || raw.id.length === 0) continue
      if (restore(raw.id, raw.usedPercent, raw.resetsAt)) restored = true
    }
    if (restored) observedAt = at
  } catch {
    // A missing or corrupt file is the same as no observation yet.
  }
}

const ensureLoaded = (): void => {
  if (!loaded) load()
}

const persist = (): void => {
  const file = filePath()
  if (file === undefined || windows.size === 0) return
  let temp: string | undefined
  try {
    mkdirSync(dirname(file), { recursive: true })
    temp = `${file}.${process.pid}.${writeSequence++}.tmp`
    const payload = {
      observedAt,
      windows: [...windows.values()].map((window) => ({
        id: window.id,
        ...(window.usedPercent === undefined ? {} : { usedPercent: window.usedPercent }),
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      })),
    }
    writeFileSync(temp, JSON.stringify(payload), "utf8")
    renameSync(temp, file)
  } catch {
    // A failed write must never interrupt the model stream.
    if (temp !== undefined) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // Best effort: the temp file is already unusable.
      }
    }
  }
}

/** Upstream sends a 0-1 fraction here; `/usage` documents 0-100. Accept both. */
const usedPercent = (value: number | null | undefined): number | undefined => {
  if (value === undefined || value === null || !Number.isFinite(value)) return undefined
  return value >= 0 && value <= 1 ? value * 100 : value
}

const SECOND_MS_THRESHOLD = 1_000_000_000_000

const resetsAt = (value: number | null | undefined): number | undefined => {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return undefined
  return value < SECOND_MS_THRESHOLD ? Math.round(value * 1000) : Math.round(value)
}

const put = (id: string, input: UnifiedWindow): boolean => {
  const existing = windows.get(id)
  // The top-level fields and `unifiedWindows` describe the same window; keep
  // whichever side actually reported each value instead of blanking the other.
  const percent = usedPercent(input.utilization) ?? existing?.usedPercent
  const reset = resetsAt(input.resetsAt) ?? existing?.resetsAt
  if (percent === undefined && reset === undefined) return false
  const window = definition(id)
  windows.set(id, {
    id,
    label: window.label,
    ...(window.durationSeconds === undefined ? {} : { durationSeconds: window.durationSeconds }),
    ...(percent === undefined ? {} : { usedPercent: percent }),
    ...(reset === undefined ? {} : { resetsAt: reset }),
  })
  return true
}

/** Reads one stream event. Never throws: a malformed event simply records nothing. */
export const record = (info: SDKRateLimitInfo, now = Date.now()): void => {
  ensureLoaded()
  const unified = (info as RateLimitInfo).unifiedWindows
  let recorded = false
  if (unified !== undefined) {
    for (const [id, window] of Object.entries(unified)) {
      if (window === null || window === undefined) continue
      if (put(id, window)) recorded = true
    }
  }
  if (info.rateLimitType !== undefined) {
    if (put(info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt })) recorded = true
  }
  if (recorded) {
    observedAt = now
    persist()
  }
}

export const read = (): Observation | undefined => {
  ensureLoaded()
  if (windows.size === 0) return undefined
  return {
    windows: [...windows.values()].sort(
      (a, b) => (ORDER[a.id] ?? 99) - (ORDER[b.id] ?? 99) || a.id.localeCompare(b.id),
    ),
    observedAt,
  }
}

/** Test seam: point persistence at an isolated file; `undefined` restores the default. */
export const setStorePath = (file: string | undefined): void => {
  storePath = file
  windows.clear()
  observedAt = 0
  loaded = false
}

/** Test seam: simulate a process restart; the next read reloads the persisted file. */
export const restart = (): void => {
  windows.clear()
  observedAt = 0
  loaded = false
}

/** Test seam: drop every observation, in memory and on disk. */
export const reset = (): void => {
  restart()
  const file = filePath()
  if (file !== undefined) {
    try {
      rmSync(file, { force: true })
    } catch {
      // The in-memory state is already clear; a stale file is best effort.
    }
  }
  loaded = true
}
