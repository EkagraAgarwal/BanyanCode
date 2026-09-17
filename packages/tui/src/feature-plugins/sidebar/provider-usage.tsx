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

/** Active session provider first, then by status rank, then by display name.
 * Rank mirrors the server `STATUS_RANK` in `packages/opencode/src/provider/usage.ts`
 * (`available < stale < unauthenticated < error < unsupported`). When the
 * server omits the active provider (e.g. disabled after the session started),
 * the widget backfills an `unsupported` row so the active provider is always
 * represented and never silently dropped. */
export function orderSnapshots(
  list: ProviderUsageSnapshot[],
  activeProviderID?: string,
): ProviderUsageSnapshot[] {
  const withActive =
    activeProviderID !== undefined && !list.some((s) => s.providerID === activeProviderID)
      ? [
          ...list,
          {
            providerID: activeProviderID,
            displayName: activeProviderID,
            status: "unsupported" as const,
            confidence: "exact" as const,
            windows: [],
            fetchedAt: Date.now(),
          },
        ]
      : list
  return [...withActive].sort((a, b) => {
    if (activeProviderID !== undefined) {
      const aActive = a.providerID === activeProviderID
      const bActive = b.providerID === activeProviderID
      if (aActive !== bActive) return aActive ? -1 : 1
    }
    const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    if (rank !== 0) return rank
    return a.displayName.localeCompare(b.displayName)
  })
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
          {(s) => (
            <box flexDirection="column" gap={0} marginTop={0} width="100%">
              <box flexDirection="row" gap={1} marginTop={0} alignItems="center">
                <text fg={toHex(theme().text)} wrapMode="none">
                  {s.displayName}
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
                    {(w) => (
                      <text fg={toHex(theme().textMuted)} marginTop={0} wrapMode="none">
                        {windowRowText(w, now())}
                      </text>
                    )}
                  </For>
                </Show>
                <Show when={s.balance !== undefined}>
                  <text fg={toHex(theme().textMuted)} marginTop={0} wrapMode="none">
                    Balance {formatBalance(s.balance!)}
                  </text>
                </Show>
              </Show>
            </box>
          )}
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
