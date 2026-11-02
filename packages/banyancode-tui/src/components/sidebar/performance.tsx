import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { formatTokens } from "../../data/format"
import { lastAssistant } from "../../data/messages"
import { palette, type Palette } from "../../theme"

interface StepMetrics {
  readonly source: string
  readonly tokensPerSecond?: number
  readonly tokensOut?: number
}

type Freshness = "live" | "last" | "pending"

interface BarRow {
  readonly label: string
  readonly value: string
  /** Filled units out of `BAR_UNITS`, like the fixed 8-column bar v1 drew. */
  readonly filled: number
  readonly color: (theme: Palette) => RGBA
}

// Rendered only until the panel reports its real width through onSizeChange.
const DEFAULT_BAR_WIDTH = 8
// Below this the bar is dropped rather than squeezing the value text.
const MIN_BAR_WIDTH = 3
// One unit per 10 tokens/s, so 80 tokens/s is a full bar.
const BAR_UNITS = 8

function metricBar(filled: number, width: number): string {
  if (width <= 0) return ""
  const ratio = Math.max(1 / BAR_UNITS, Math.min(1, filled / BAR_UNITS))
  const columns = Math.max(1, Math.min(width, Math.round(ratio * width)))
  return "█".repeat(columns) + "░".repeat(Math.max(0, width - columns))
}

/**
 * Ported from v1 `sidebar/performance.tsx`. v2 step events carry tokens and a
 * timestamp but not TTFT, so the TTFT row is dropped; tokens/s is derived from
 * the step duration. The live/last cue is kept.
 */
export function PerformancePanel(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const [step, setStep] = createSignal<StepMetrics | undefined>(undefined)
  const [liveSource, setLiveSource] = createSignal<string | undefined>(undefined)
  const [liveFresh, setLiveFresh] = createSignal(false)
  // The bar stretches to the panel's content width, like the System meters, and
  // reallocates its columns whenever the sidebar resizes.
  const [panelWidth, setPanelWidth] = createSignal(0)
  const startedAt = new Map<string, number>()

  const offStart = props.context.data.on("session.step.started", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    startedAt.set(event.data.assistantMessageID, event.data.started)
    setLiveSource(event.data.assistantMessageID)
    setLiveFresh(false)
  })
  const offEnded = props.context.data.on("session.step.ended", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    const started = startedAt.get(event.data.assistantMessageID)
    const durationMs = started === undefined ? undefined : event.created - started
    const output = event.data.tokens.output
    const tps = durationMs !== undefined && durationMs > 0 ? (output / durationMs) * 1000 : undefined
    setStep({ source: event.data.assistantMessageID, tokensPerSecond: tps, tokensOut: output })
    if (liveSource() === event.data.assistantMessageID) {
      setLiveFresh(true)
      setLiveSource(undefined)
    }
  })
  onCleanup(() => {
    offStart()
    offEnded()
  })

  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const inFlight = createMemo(() => {
    const list = messages()
    return lastAssistant(list, false)
  })

  const fallback = createMemo<StepMetrics | undefined>(() => {
    const message = lastAssistant(messages(), true)
    if (!message) return undefined
    const completed = message.time.completed
    const created = message.time.created
    const durationMs = completed === undefined ? undefined : completed - created
    const tps =
      durationMs !== undefined && durationMs > 0 && message.tokens
        ? (message.tokens.output / durationMs) * 1000
        : undefined
    return { source: message.id, tokensPerSecond: tps, tokensOut: message.tokens?.output }
  })

  const active = createMemo<StepMetrics | undefined>(() => {
    const current = step()
    if (current && messages().some((message) => message.id === current.source)) return current
    return fallback()
  })

  const freshness = createMemo<Freshness>(() => {
    if (!active()) return "pending"
    if (inFlight() && liveSource() !== undefined && liveSource() !== step()?.source) return "pending"
    return liveFresh() ? "live" : "last"
  })

  const cue = () => (freshness() === "live" ? "now" : freshness() === "last" ? "last" : "—")

  const rows = createMemo<BarRow[]>(() => {
    const metrics = active()
    if (!metrics) return []
    const list: BarRow[] = []
    if (metrics.tokensPerSecond !== undefined) {
      list.push({
        label: "Tokens/s",
        value: metrics.tokensPerSecond.toFixed(1),
        filled: Math.min(BAR_UNITS, Math.max(1, Math.round(metrics.tokensPerSecond / 10))),
        color: (value) => value.success,
      })
    }
    if (metrics.tokensOut !== undefined && metrics.tokensPerSecond !== undefined) {
      list.push({
        label: "Output",
        value: formatTokens(metrics.tokensOut),
        filled: Math.min(BAR_UNITS, Math.max(1, Math.round(metrics.tokensOut / 100))),
        color: (value) => value.info,
      })
    }
    return list
  })

  // One label column and one value column for the whole panel, so the bars start
  // and end on the same columns even when the values differ in length.
  const layout = createMemo(() => {
    const list = rows()
    const label = Math.max(0, ...list.map((row) => row.label.length)) + 1
    const value = Math.max(0, ...list.map((row) => row.value.length)) + 1
    const width = panelWidth()
    const bar = width === 0 ? DEFAULT_BAR_WIDTH : Math.max(0, width - label - value)
    return { label, value, bar, show: bar >= MIN_BAR_WIDTH }
  })

  return (
    <box
      flexDirection="column"
      width="100%"
      onSizeChange={function (this: BoxRenderable) {
        setPanelWidth(this.width)
      }}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={theme().primary}>
          <b>PERFORMANCE</b>
        </text>
        <Show when={active() && freshness() !== "pending"}>
          <text fg={theme().muted}>{cue()}</text>
        </Show>
      </box>
      <Show
        when={active()}
        fallback={<text fg={theme().muted}>step metrics after first turn</text>}
      >
        {(metrics) => (
          <box flexDirection="column" gap={0} width="100%">
            <Show when={metrics().tokensPerSecond === undefined}>
              <text fg={theme().muted}>
                tool-only step · {formatTokens(metrics().tokensOut ?? 0)} tokens
              </text>
            </Show>
            <For each={rows()}>
              {(row) => (
                <box flexDirection="row" width="100%" height={1} alignItems="center">
                  <text fg={theme().muted} width={layout().label} flexShrink={0}>
                    {row.label}
                  </text>
                  <box flexGrow={1} flexShrink={1} height={1} minWidth={0}>
                    <Show when={layout().show}>
                      <text fg={row.color(theme())}>{metricBar(row.filled, layout().bar)}</text>
                    </Show>
                  </box>
                  <text fg={row.color(theme())} width={layout().value} flexShrink={0}>
                    {row.value.padStart(layout().value)}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  )
}
