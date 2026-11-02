import type { Context } from "@opencode/plugin/tui/context"
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

  // A response can reveal new Claude Agent limits. Forcing a refresh when the
  // session goes idle shows them without waiting for the poll interval.
  const unsubscribeIdle = props.context.data.on("session.idle", () => void refresh(true))
  const poll = setInterval(() => void refresh(false), PROVIDER_USAGE_POLL_MS)
  const tick = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
  onCleanup(() => {
    unsubscribeIdle()
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

  return (
    <Show when={ordered().length > 0 || unavailable()}>
      <Show
        when={!unavailable()}
        fallback={<text fg={theme().muted}>Provider usage: RPC not available</text>}
      >
        <box flexDirection="column" gap={0}>
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
                        const parts = () => windowParts(window, now())
                        const tone = (): QuotaTone =>
                          snapshot.status === "stale" || windowPercent(window) === undefined
                            ? "unavailable"
                            : quotaTone(windowPercent(window))
                        return (
                          <box flexDirection="row" gap={1} width="100%" height={1}>
                            <text fg={theme().muted}>{parts().label}</text>
                            <text fg={quotaColor(tone(), theme())}>{parts().bar}</text>
                            <Show when={parts().remainder !== undefined}>
                              <text fg={quotaColor(tone(), theme())}>{parts().remainder}</text>
                            </Show>
                            <Show when={parts().countdown !== undefined}>
                              <text fg={theme().muted}>{parts().countdown}</text>
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
