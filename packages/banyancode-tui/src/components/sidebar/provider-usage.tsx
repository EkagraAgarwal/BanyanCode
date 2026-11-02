import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { truncate } from "../../data/format"
import type { UsageLive } from "../../data/live"
import {
  COUNTDOWN_TICK_MS,
  PROVIDER_USAGE_POLL_MS,
  canonicalDisplayName,
  orderSnapshots,
  quotaTone,
  statusLine,
  windowParts,
  windowPercent,
  type QuotaTone,
} from "../../data/usage"
import { palette, type Palette } from "../../theme"

function quotaColor(tone: QuotaTone, theme: Palette) {
  if (tone === "healthy") return theme.success
  if (tone === "moderate") return theme.warning
  if (tone === "low") return theme.error
  return theme.muted
}

// Rendered only until the panel reports its real width through onSizeChange.
const DEFAULT_BAR_WIDTH = 9
// Below this the bar is dropped rather than squeezing the quota text.
const MIN_BAR_WIDTH = 3

/**
 * Ported from v1 `sidebar/provider-usage.tsx`. Snapshots come from the
 * `banyancode.usage` RPC placeholder; failed fetches keep the last good
 * snapshot instead of clearing the panel.
 */
export function ProviderUsagePanel(props: {
  readonly context: Context
  readonly sessionID?: string
  readonly usage: UsageLive
}) {
  const theme = () => palette(props.context.theme)
  const [now, setNow] = createSignal(Date.now())
  const [failed, setFailed] = createSignal(false)

  const refresh = async (force = false) => {
    await props.usage.refreshProviders(force)
    setFailed(props.usage.providersAvailability() !== "available")
  }

  onMount(() => {
    void refresh(false)
  })

  // A response can reveal new Claude Agent limits. A plain read after the step
  // ends shows them without forcing requests for the other providers.
  const offStep = props.context.data.on("session.step.ended", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    void refresh(false)
  })
  const poll = setInterval(() => void refresh(false), PROVIDER_USAGE_POLL_MS)
  const tick = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
  onCleanup(() => {
    offStep()
    clearInterval(poll)
    clearInterval(tick)
  })

  const activeProviderID = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return undefined
    return props.context.data.session.get(sessionID)?.model?.providerID
  })

  const ordered = createMemo(() => orderSnapshots(props.usage.providers() ?? [], activeProviderID()))
  const showStale = createMemo(() => failed() || ordered().some((snapshot) => snapshot.status === "stale"))
  const unavailable = createMemo(() => props.usage.providersAvailability() === "unavailable" && ordered().length === 0)
  // The bars stretch to the panel's content width, like the System meters, and
  // reallocate their columns whenever the sidebar resizes.
  const [panelWidth, setPanelWidth] = createSignal(0)

  const rows = createMemo(() =>
    ordered().flatMap((snapshot) => {
      if (snapshot.status !== "available" && snapshot.status !== "stale") return []
      return snapshot.windows.map((window) => ({ window, parts: windowParts(window, now()) }))
    }),
  )

  // One label column and one value column for the whole panel, so every bar
  // starts and ends on the same columns even when the quota text differs.
  const layout = createMemo(() => {
    const list = rows()
    const label = Math.max(0, ...list.map((row) => row.parts.label.length)) + 1
    const remainder = Math.max(0, ...list.map((row) => row.parts.remainder?.length ?? 0))
    const countdown = Math.max(0, ...list.map((row) => row.parts.countdown?.length ?? 0))
    const value = (remainder > 0 ? remainder + 1 : 0) + (countdown > 0 ? countdown + 1 : 0)
    const width = panelWidth()
    const bar = width === 0 ? DEFAULT_BAR_WIDTH : Math.max(0, width - label - value)
    return { label, remainder, countdown, bar, show: bar >= MIN_BAR_WIDTH }
  })

  return (
    <Show when={ordered().length > 0 || unavailable()}>
      <Show
        when={!unavailable()}
        fallback={<text fg={theme().muted}>Provider usage: RPC not available</text>}
      >
        <box
          flexDirection="column"
          gap={0}
          width="100%"
          onSizeChange={function (this: BoxRenderable) {
            setPanelWidth(this.width)
          }}
        >
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme().primary}>
              <b>USAGE</b>
            </text>
            <Show when={showStale()}>
              <text fg={theme().muted}>stale</text>
            </Show>
          </box>
          <For each={ordered()}>
            {(snapshot) => (
              <box flexDirection="column" gap={0} width="100%">
                <box flexDirection="row" gap={1} alignItems="center">
                  <text fg={theme().text}>{truncate(canonicalDisplayName(snapshot.providerID, snapshot.displayName), 32)}</text>
                  <Show when={snapshot.status === "stale"}>
                    <text fg={theme().muted}>stale</text>
                  </Show>
                </box>
                <Show
                  when={snapshot.status === "available" || snapshot.status === "stale"}
                  fallback={<text fg={theme().muted}>{statusLine(snapshot)}</text>}
                >
                  <Show
                    when={snapshot.windows.length > 0}
                    fallback={<text fg={theme().muted}>{snapshot.message ?? "Usage unavailable"}</text>}
                  >
                    <For each={snapshot.windows}>
                      {(window) => {
                        const parts = () => windowParts(window, now(), layout().bar)
                        const tone = (): QuotaTone =>
                          snapshot.status === "stale" || windowPercent(window) === undefined
                            ? "unavailable"
                            : quotaTone(windowPercent(window))
                        return (
                          <box flexDirection="row" width="100%" height={1} alignItems="center">
                            <text fg={theme().muted} width={layout().label} flexShrink={0}>
                              {parts().label}
                            </text>
                            <box flexGrow={1} flexShrink={1} height={1} minWidth={0}>
                              <Show when={layout().show}>
                                <text fg={quotaColor(tone(), theme())}>{parts().bar}</text>
                              </Show>
                            </box>
                            <Show when={layout().remainder > 0}>
                              <text
                                fg={quotaColor(tone(), theme())}
                                width={layout().remainder + 1}
                                flexShrink={0}
                              >
                                {(parts().remainder ?? "").padStart(layout().remainder + 1)}
                              </text>
                            </Show>
                            <Show when={layout().countdown > 0}>
                              <text fg={theme().muted} width={layout().countdown + 1} flexShrink={0}>
                                {" " + (parts().countdown ?? "").padStart(layout().countdown)}
                              </text>
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                  </Show>
                  <Show when={snapshot.balance}>
                    {(balance) => (
                      <text fg={theme().muted}>
                        Balance {balance().remaining}
                        {balance().currency ? ` ${balance().currency}` : ""}
                      </text>
                    )}
                  </Show>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>
    </Show>
  )
}
