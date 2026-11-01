import type { ProviderUsageSnapshot, ProviderUsageWindow } from "./pending-rpc"

const BAR_WIDTH = 9

export const PROVIDER_USAGE_POLL_MS = 60_000
export const COUNTDOWN_TICK_MS = 30_000

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export function asciiBar(percent: number, width = BAR_WIDTH): string {
  const filled = Math.round((clampPercent(percent) / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

/** Remaining percent for a window, or undefined when the provider gave no usable limit. */
export function windowPercent(window: ProviderUsageWindow): number | undefined {
  if (window.remainingPercent !== undefined) return clampPercent(window.remainingPercent)
  if (window.usedPercent !== undefined && Number.isFinite(window.usedPercent)) return clampPercent(100 - window.usedPercent)
  if (window.remaining !== undefined && window.limit !== undefined && window.limit > 0) {
    return clampPercent((window.remaining / window.limit) * 100)
  }
  return undefined
}

export function remainderText(window: ProviderUsageWindow): string | undefined {
  if (window.remaining !== undefined && window.limit !== undefined) return `${window.remaining}/${window.limit}`
  const percent = windowPercent(window)
  return percent === undefined ? undefined : `${Math.round(percent)}%`
}

export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days}d` : `${days}d${rest}h`
}

export interface WindowParts {
  readonly label: string
  readonly bar: string
  readonly remainder?: string
  readonly countdown?: string
}

export function windowParts(window: ProviderUsageWindow, nowMs: number): WindowParts {
  const percent = windowPercent(window)
  const remainder = remainderText(window)
  const countdown = window.resetsAt === undefined ? undefined : formatCountdown(window.resetsAt - nowMs)
  return {
    label: window.label,
    bar: percent === undefined ? "░".repeat(BAR_WIDTH) : asciiBar(percent),
    ...(remainder === undefined ? {} : { remainder }),
    ...(countdown === undefined ? {} : { countdown }),
  }
}

export type QuotaTone = "healthy" | "moderate" | "low" | "unavailable"

/** Thresholds mirror the System panel: >=85 used (<=15 left) low, <=40 left moderate. */
export function quotaTone(percent: number | undefined): QuotaTone {
  if (percent === undefined || !Number.isFinite(percent)) return "unavailable"
  if (percent <= 15) return "low"
  if (percent <= 40) return "moderate"
  return "healthy"
}

const STATUS_RANK: Record<ProviderUsageSnapshot["status"], number> = {
  available: 0,
  stale: 1,
  unauthenticated: 2,
  error: 3,
  unsupported: 4,
}

/** `opencode` and `opencode-go` are one provider; the canonical row is labelled OpenCode. */
export const OPENCODE_ALIAS_IDS = ["opencode", "opencode-go"] as const
export const OPENCODE_CANONICAL_ID = "opencode-go"
export const OPENCODE_CANONICAL_NAME = "OpenCode"

export function canonicalProviderID(providerID: string): string {
  return (OPENCODE_ALIAS_IDS as readonly string[]).includes(providerID) ? OPENCODE_CANONICAL_ID : providerID
}

const BUILT_IN_CANONICAL_NAMES: Record<string, string> = {
  opencode: OPENCODE_CANONICAL_NAME,
  "opencode-go": OPENCODE_CANONICAL_NAME,
  openai: "OpenAI",
  "openai-codex": "ChatGPT",
  codex: "ChatGPT",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  gemini: "Gemini",
}

export function canonicalDisplayName(providerID: string, displayName?: string): string {
  const canonical = canonicalProviderID(providerID)
  if (canonical === OPENCODE_CANONICAL_ID) return OPENCODE_CANONICAL_NAME
  if (displayName && displayName.length > 0 && displayName !== providerID) return displayName
  return BUILT_IN_CANONICAL_NAMES[providerID] ?? displayName ?? providerID
}

function sameProvider(a: string, b: string): boolean {
  return a === b || canonicalProviderID(a) === canonicalProviderID(b)
}

export function dedupeSnapshots(list: readonly ProviderUsageSnapshot[]): ProviderUsageSnapshot[] {
  const best = new Map<string, ProviderUsageSnapshot>()
  for (const item of list) {
    const key = canonicalProviderID(item.providerID)
    const previous = best.get(key)
    if (!previous) {
      best.set(key, item)
      continue
    }
    const rank = (STATUS_RANK[item.status] ?? 9) - (STATUS_RANK[previous.status] ?? 9)
    if (rank < 0 || (rank === 0 && item.fetchedAt >= previous.fetchedAt)) best.set(key, item)
  }
  return [...best.entries()].map(([key, item]) => ({
    ...item,
    providerID: key,
    displayName: canonicalDisplayName(key, item.displayName),
  }))
}

/** Active session provider first, then health rank, then display name. */
export function orderSnapshots(
  list: readonly ProviderUsageSnapshot[],
  activeProviderID?: string,
): ProviderUsageSnapshot[] {
  const deduped = dedupeSnapshots(list)
  const canonicalActive = activeProviderID === undefined ? undefined : canonicalProviderID(activeProviderID)
  const withActive =
    canonicalActive !== undefined && !deduped.some((snapshot) => sameProvider(snapshot.providerID, canonicalActive))
      ? [
          ...deduped,
          {
            providerID: canonicalActive,
            displayName: canonicalDisplayName(canonicalActive, activeProviderID),
            status: "unsupported" as const,
            confidence: "exact" as const,
            windows: [],
            fetchedAt: Date.now(),
          },
        ]
      : deduped
  return [...withActive].sort((a, b) => {
    if (canonicalActive !== undefined) {
      const aActive = sameProvider(a.providerID, canonicalActive)
      const bActive = sameProvider(b.providerID, canonicalActive)
      if (aActive !== bActive) return aActive ? -1 : 1
    }
    const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    if (rank !== 0) return rank
    return canonicalDisplayName(a.providerID, a.displayName).localeCompare(
      canonicalDisplayName(b.providerID, b.displayName),
    )
  })
}

export function statusLine(snapshot: ProviderUsageSnapshot): string {
  if (snapshot.status === "unauthenticated") return "Not connected"
  if (snapshot.status === "unsupported") return "Usage unavailable"
  if (snapshot.status === "error") return snapshot.message?.slice(0, 80) || "Couldn't load usage"
  return ""
}

/** Tool IDs that count as graph adoption in the tool-usage summary. */
export const GRAPH_FAMILY = new Set([
  "codegraph_build",
  "codegraph_remove",
  "code_find",
  "repository_query",
  "repository_explain",
  "repository_impact",
  "repository_trace",
  "repository_tests",
  "blast_radius",
  "preflight",
  "safe_rename",
  "edit_plan",
  "banyan_tool_search",
  "banyan_test",
])
