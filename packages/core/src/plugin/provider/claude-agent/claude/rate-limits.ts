export * as ClaudeRateLimits from "./rate-limits.js"

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

/**
 * Claude Code plan utilization observed from the Agent SDK stream.
 *
 * The SDK emits `rate_limit_event` whenever Claude Code learns new plan
 * limits. Those events are the only credential-free source the Claude Agent
 * provider has (the login belongs to the `claude` CLI), so the sidebar reads
 * this process-local store instead of probing Claude's files or tokens.
 * Values are reported verbatim — a missing utilization stays missing.
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

const windows = new Map<string, Window>()
let observedAt = 0

const definition = (id: string) =>
  DEFINITIONS[id as WindowID] ?? { label: id.replaceAll("_", " "), durationSeconds: undefined }

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
  if (recorded) observedAt = now
}

export const read = (): Observation | undefined => {
  if (windows.size === 0) return undefined
  return {
    windows: [...windows.values()].sort(
      (a, b) => (ORDER[a.id] ?? 99) - (ORDER[b.id] ?? 99) || a.id.localeCompare(b.id),
    ),
    observedAt,
  }
}

/** Test seam: drop every observation. */
export const reset = (): void => {
  windows.clear()
  observedAt = 0
}
