/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"

const id = "internal:sidebar-provider-usage"

export const PROVIDER_USAGE_ORDER = 135
export const PROVIDER_USAGE_POLL_MS = 60_000
const COUNTDOWN_TICK_MS = 30_000
const BAR_WIDTH = 9

export interface ProviderUsageWindow {
  id: string
  label: string
  kind: "quota" | "rate_limit"
  usedPercent?: number
  remainingPercent?: number
  resetsAt?: number
  durationSeconds?: number
  limit?: number
  remaining?: number
}

export interface ProviderUsageSnapshot {
  providerID: string
  displayName: string
  status: "available" | "stale" | "unsupported" | "unauthenticated" | "error"
  confidence: "exact" | "reported" | "estimated"
  windows: ProviderUsageWindow[]
  balance?: {
    remaining: number
    currency?: string
  }
  message?: string
  fetchedAt: number
}

type WireNumber = number | string
type WireSnapshot = Omit<ProviderUsageSnapshot, "windows" | "balance" | "fetchedAt"> & {
  windows: Array<
    Omit<ProviderUsageWindow, "usedPercent" | "remainingPercent" | "resetsAt" | "durationSeconds" | "limit" | "remaining"> & {
      usedPercent?: WireNumber
      remainingPercent?: WireNumber
      resetsAt?: WireNumber
      durationSeconds?: WireNumber
      limit?: WireNumber
      remaining?: WireNumber
    }
  >
  balance?: { remaining: WireNumber; currency?: string }
  fetchedAt: WireNumber
}

function finite(value: number | string | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function fromWire(snapshot: WireSnapshot): ProviderUsageSnapshot {
  const balanceRemaining = finite(snapshot.balance?.remaining)
  return {
    providerID: snapshot.providerID,
    displayName: snapshot.displayName,
    status: snapshot.status,
    confidence: snapshot.confidence,
    windows: snapshot.windows.map((window) => ({
      id: window.id,
      label: window.label,
      kind: window.kind,
      ...(finite(window.usedPercent) !== undefined ? { usedPercent: finite(window.usedPercent) } : {}),
      ...(finite(window.remainingPercent) !== undefined ? { remainingPercent: finite(window.remainingPercent) } : {}),
      ...(finite(window.resetsAt) !== undefined ? { resetsAt: finite(window.resetsAt) } : {}),
      ...(finite(window.durationSeconds) !== undefined ? { durationSeconds: finite(window.durationSeconds) } : {}),
      ...(finite(window.limit) !== undefined ? { limit: finite(window.limit) } : {}),
      ...(finite(window.remaining) !== undefined ? { remaining: finite(window.remaining) } : {}),
    })),
    ...(balanceRemaining !== undefined
      ? { balance: { remaining: balanceRemaining, ...(snapshot.balance?.currency ? { currency: snapshot.balance.currency } : {}) } }
      : {}),
    ...(snapshot.message ? { message: snapshot.message } : {}),
    fetchedAt: finite(snapshot.fetchedAt) ?? Date.now(),
  }
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

export function asciiBar(percent: number, width = BAR_WIDTH): string {
  const filled = Math.round((clampPercent(percent) / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

/** Remaining percent for a window, or undefined when the provider gave no usable limit. */
export function windowPercent(w: ProviderUsageWindow): number | undefined {
  if (w.remainingPercent !== undefined) return clampPercent(w.remainingPercent)
  if (w.usedPercent !== undefined && Number.isFinite(w.usedPercent)) return clampPercent(100 - w.usedPercent)
  if (w.remaining !== undefined && w.limit !== undefined && w.limit > 0) {
    return clampPercent((w.remaining / w.limit) * 100)
  }
  return undefined
}

/** Remaining text: raw remaining/limit for count-based rate limits, else percent. */
export function remainderText(w: ProviderUsageWindow): string | undefined {
  if (w.remaining !== undefined && w.limit !== undefined) return `${w.remaining}/${w.limit}`
  const pct = windowPercent(w)
  if (pct !== undefined) return `${Math.round(pct)}%`
  return undefined
}

export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) {
    const mm = m % 60
    return mm === 0 ? `${h}h` : `${h}h${mm}m`
  }
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh === 0 ? `${d}d` : `${d}d${hh}h`
}

/** One terminal row per window: label, compact bar, remainder, reset countdown. */
export function windowRowText(w: ProviderUsageWindow, nowMs: number): string {
  const pct = windowPercent(w)
  const parts = [w.label, pct === undefined ? "░".repeat(BAR_WIDTH) : asciiBar(pct)]
  const rem = remainderText(w)
  if (rem !== undefined) parts.push(rem)
  if (w.resetsAt !== undefined) parts.push(formatCountdown(w.resetsAt - nowMs))
  return parts.join("  ")
}

export function formatBalance(balance: NonNullable<ProviderUsageSnapshot["balance"]>): string {
  return balance.currency ? `${balance.remaining} ${balance.currency}` : `${balance.remaining}`
}

/** Non-window status line. Server messages are normalized user-safe; still truncated. */
export function statusLine(s: ProviderUsageSnapshot): string {
  if (s.status === "unauthenticated") return "Not connected"
  if (s.status === "unsupported") return "Usage unavailable"
  if (s.status === "error") return s.message?.slice(0, 80) || "Couldn't load usage"
  return ""
}

const STATUS_RANK: Record<ProviderUsageSnapshot["status"], number> = {
  available: 0,
  stale: 1,
  unauthenticated: 2,
  error: 3,
  unsupported: 4,
}

/** `opencode` and `opencode-go` are one provider; the canonical row is `opencode-go` labelled `OpenCode`. */
export const OPENCODE_ALIAS_IDS = ["opencode", "opencode-go"] as const
export const OPENCODE_CANONICAL_ID = "opencode-go"
export const OPENCODE_CANONICAL_NAME = "OpenCode"

export const canonicalProviderID = (providerID: string): string =>
  (OPENCODE_ALIAS_IDS as readonly string[]).includes(providerID) ? OPENCODE_CANONICAL_ID : providerID

export const isSameProvider = (a: string, b: string): boolean =>
  a === b || canonicalProviderID(a) === canonicalProviderID(b)

const BUILT_IN_CANONICAL_NAMES: Record<string, string> = {
  "opencode": OPENCODE_CANONICAL_NAME,
  "opencode-go": OPENCODE_CANONICAL_NAME,
  "openai": "OpenAI",
  "openai-codex": "ChatGPT",
  "codex": "ChatGPT",
  "anthropic": "Anthropic",
  "openrouter": "OpenRouter",
  "github-copilot": "GitHub Copilot",
  "gemini": "Gemini",
}

/** Canonical label for rendering and backfill. Server snapshots are already
 * canonicalized; this is defense in depth for stale/foreign payloads where
 * `displayName` still equals the raw provider ID. Custom names are preserved. */
export function canonicalDisplayNameFor(providerID: string, displayName?: string): string {
  const canonical = canonicalProviderID(providerID)
  if (canonical === OPENCODE_CANONICAL_ID) return OPENCODE_CANONICAL_NAME
  if (displayName && displayName.length > 0 && displayName !== providerID) return displayName
  return BUILT_IN_CANONICAL_NAMES[providerID] ?? displayName ?? providerID
}

export function displayNameFor(s: ProviderUsageSnapshot): string {
  return canonicalDisplayNameFor(s.providerID, s.displayName)
}

/** Collapse alias snapshots to one row per canonical provider. Keeps the
 * healthiest status (lowest rank), breaking ties by newest `fetchedAt`.
 * The surviving row is normalized to the canonical providerID/displayName
 * (`opencode-go`/`OpenCode`) so a legacy winner never leaks its raw ID. */
export function dedupeSnapshots(list: ProviderUsageSnapshot[]): ProviderUsageSnapshot[] {
  const best = new Map<string, ProviderUsageSnapshot>()
  for (const item of list) {
    const key = canonicalProviderID(item.providerID)
    const prev = best.get(key)
    if (!prev) {
      best.set(key, item)
      continue
    }
    const rank = (STATUS_RANK[item.status] ?? 9) - (STATUS_RANK[prev.status] ?? 9)
    if (rank < 0 || (rank === 0 && item.fetchedAt >= prev.fetchedAt)) best.set(key, item)
  }
  return [...best.entries()].map(([key, item]) => ({
    ...item,
    providerID: key,
    displayName: canonicalDisplayNameFor(key, item.displayName),
  }))
}

/** Quota tone drives the semantic remainder color. Thresholds mirror the
 * System Resources pattern (used >=85 error, >=60 warning) expressed on
 * remaining: <=15 low, <=40 moderate, else healthy. No percent reads muted. */
export type QuotaTone = "healthy" | "moderate" | "low" | "unavailable"

export function quotaToneFor(percent: number | undefined): QuotaTone {
  if (percent === undefined || !Number.isFinite(percent)) return "unavailable"
  if (percent <= 15) return "low"
  if (percent <= 40) return "moderate"
  return "healthy"
}

/** Minimal theme surface for quota colors. Field types mirror `toHex`'s
 * accepted color input, so any full theme satisfies this structurally. */
type QuotaColorInput = Parameters<typeof toHex>[0]
export interface QuotaTheme {
  readonly success: QuotaColorInput
  readonly warning: QuotaColorInput
  readonly error: QuotaColorInput
  readonly textMuted: QuotaColorInput
}

export function quotaColorFor(tone: QuotaTone, theme: QuotaTheme): string {
  switch (tone) {
    case "healthy":
      return toHex(theme.success)
    case "moderate":
      return toHex(theme.warning)
    case "low":
      return toHex(theme.error)
    case "unavailable":
      return toHex(theme.textMuted)
  }
}

/** Width-aware truncation for narrow terminals. Keeps one terminal row. */
export function truncateText(text: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return ""
  if (text.length <= maxWidth) return text
  if (maxWidth <= 1) return "…".slice(0, maxWidth)
  return text.slice(0, maxWidth - 1) + "…"
}

/** Window row text optionally fitted to `maxWidth` for narrow rendering. */
export function windowRowTextForWidth(w: ProviderUsageWindow, nowMs: number, maxWidth?: number): string {
  const row = windowRowText(w, nowMs)
  return maxWidth === undefined ? row : truncateText(row, maxWidth)
}

/** Active session provider first, then by status rank, then by display name.
 * Rank mirrors the server `STATUS_RANK` in `packages/opencode/src/provider/usage.ts`
 * (`available < stale < unauthenticated < error < unsupported`). Alias-aware:
 * `opencode` and `opencode-go` count as the same provider, snapshots are
 * deduped to one canonical row, and the backfilled active row uses the
 * canonical ID/label so it merges instead of duplicating. */
export function orderSnapshots(
  list: ProviderUsageSnapshot[],
  activeProviderID?: string,
): ProviderUsageSnapshot[] {
  const deduped = dedupeSnapshots(list)
  const canonicalActive = activeProviderID !== undefined ? canonicalProviderID(activeProviderID) : undefined
  const withActive =
    canonicalActive !== undefined && !deduped.some((s) => isSameProvider(s.providerID, canonicalActive))
      ? [
          ...deduped,
          {
            providerID: canonicalActive,
            displayName: canonicalDisplayNameFor(canonicalActive, activeProviderID),
            status: "unsupported" as const,
            confidence: "exact" as const,
            windows: [],
            fetchedAt: Date.now(),
          },
        ]
      : deduped
  return [...withActive].sort((a, b) => {
    if (canonicalActive !== undefined) {
      const aActive = isSameProvider(a.providerID, canonicalActive)
      const bActive = isSameProvider(b.providerID, canonicalActive)
      if (aActive !== bActive) return aActive ? -1 : 1
    }
    const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    if (rank !== 0) return rank
    return displayNameFor(a).localeCompare(displayNameFor(b))
  })
}

/** Split a window row into label, bar, remainder, and countdown segments.
 * Keeps one terminal row per window: the View renders every part in a single
 * height-1 row box, so color never adds vertical rows. The bar and remainder
 * carry the quota tone (healthy/moderate/low); the label and countdown stay
 * muted so only quota state carries color. */
export interface WindowParts {
  readonly label: string
  readonly bar: string
  readonly remainder?: string
  readonly countdown?: string
}

export function windowParts(w: ProviderUsageWindow, nowMs: number): WindowParts {
  const pct = windowPercent(w)
  const bar = pct === undefined ? "░".repeat(BAR_WIDTH) : asciiBar(pct)
  const remainder = remainderText(w)
  const countdown = w.resetsAt !== undefined ? formatCountdown(w.resetsAt - nowMs) : undefined
  return {
    label: w.label,
    bar,
    ...(remainder !== undefined ? { remainder } : {}),
    ...(countdown !== undefined ? { countdown } : {}),
  }
}

export function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const sdk = useSDK()
  const sync = useSync()
  const ev = useEvent()

  // Last good snapshot. Failed fetches never clear it (stale rendering).
  const [snapshots, setSnapshots] = createSignal<ProviderUsageSnapshot[] | undefined>(undefined)
  const [failed, setFailed] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const applySnapshots = (list: ProviderUsageSnapshot[] | undefined) => {
    if (list !== undefined) {
      setSnapshots(list)
      setFailed(false)
    }
  }

  const fetchSnapshots = async (): Promise<ProviderUsageSnapshot[] | undefined> => {
    const result = await sdk.client.global.providerUsage.list()
    return result.data?.snapshots.map(fromWire)
  }

  const refreshSnapshots = async (): Promise<ProviderUsageSnapshot[] | undefined> => {
    const result = await sdk.client.global.providerUsage.refresh()
    return result.data?.snapshots.map(fromWire)
  }

  // Fail independently: errors keep the last good snapshot, never throw.
  const fetchList = async () => {
    try {
      applySnapshots(await fetchSnapshots())
    } catch {
      setFailed(true)
    }
  }

  const refresh = async () => {
    try {
      const list = await refreshSnapshots()
      if (list !== undefined) applySnapshots(list)
      else await fetchList()
    } catch {
      setFailed(true)
    }
  }

  const unsubs = [
    ev.on("session.idle", () => void refresh()),
    ev.on("session.updated", () => void refresh()),
    ev.on("account.added", () => void refresh()),
    ev.on("account.removed", () => void refresh()),
    ev.on("account.switched", () => void refresh()),
    ev.on("server.connected", () => void fetchList()),
  ]

  // Poll the cached list every 60s; the server refreshes stale entries in the
  // background (`ProviderUsage.snapshots`), so polling stays light. Forced
  // `refresh` runs on session/auth events and on user action, never on a timer.
  const poll = setInterval(() => void fetchList(), PROVIDER_USAGE_POLL_MS)
  const tick = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)

  onMount(() => void fetchList())

  onCleanup(() => {
    clearInterval(poll)
    clearInterval(tick)
    for (const unsub of unsubs) unsub()
  })

  const activeProviderID = () => sync.data.session.find((s) => s.id === props.session_id)?.model?.providerID
  const ordered = () => orderSnapshots(snapshots() ?? [], activeProviderID())
  const showStale = () => failed() || ordered().some((s) => s.status === "stale")

  return (
    <Show when={ordered().length > 0}>
      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1} marginTop={0} alignItems="center">
          <text fg={toHex(theme().primary)}>
            <b>USAGE</b>
          </text>
          <Show when={showStale()}>
            <text fg={toHex(theme().textMuted)}>stale</text>
          </Show>
        </box>
        <For each={ordered()}>
          {(s) => {
            const name = () => truncateText(displayNameFor(s), 32)
            return (
              <box flexDirection="column" gap={0} marginTop={0} width="100%">
                <box flexDirection="row" gap={1} marginTop={0} alignItems="center">
                  <text fg={toHex(theme().text)} wrapMode="none">
                    {name()}
                  </text>
                  <Show when={s.status === "stale"}>
                    <text fg={toHex(theme().textMuted)}>stale</text>
                  </Show>
                </box>
                <Show
                  when={s.status === "available" || s.status === "stale"}
                  fallback={
                    <text fg={toHex(theme().textMuted)} marginTop={0} wrapMode="none">
                      {statusLine(s)}
                    </text>
                  }
                >
                  <Show
                    when={s.windows.length > 0}
                    fallback={
                      <text fg={toHex(theme().textMuted)} marginTop={0} wrapMode="none">
                        Usage unavailable
                      </text>
                    }
                  >
                    <For each={s.windows}>
                      {(w) => {
                        const parts = () => windowParts(w, now())
                        const tone = (): QuotaTone =>
                          s.status === "stale" || windowPercent(w) === undefined
                            ? "unavailable"
                            : quotaToneFor(windowPercent(w))
                        const quotaFg = () => quotaColorFor(tone(), theme())
                        const mutedFg = () => toHex(theme().textMuted)
                        return (
                          <box flexDirection="row" gap={1} marginTop={0} width="100%" height={1}>
                            <text fg={mutedFg()} wrapMode="none">
                              {parts().label}
                            </text>
                            <text fg={quotaFg()} wrapMode="none">
                              {parts().bar}
                            </text>
                            <Show when={parts().remainder !== undefined}>
                              <text fg={quotaFg()} wrapMode="none">
                                {parts().remainder}
                              </text>
                            </Show>
                            <Show when={parts().countdown !== undefined}>
                              <text fg={mutedFg()} wrapMode="none">
                                {parts().countdown}
                              </text>
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                  </Show>
                  <Show when={s.balance}>
                    {(balance) => (
                      <text fg={toHex(theme().textMuted)} marginTop={0} wrapMode="none">
                        Balance {formatBalance(balance())}
                      </text>
                    )}
                  </Show>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: PROVIDER_USAGE_ORDER,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
