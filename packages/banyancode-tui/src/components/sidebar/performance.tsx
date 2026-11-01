import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { formatTokens } from "../../data/format"
import { lastAssistant } from "../../data/messages"
import { palette, type Palette } from "../../theme"

interface StepMetrics {
  readonly source: string
  readonly tokensPerSecond?: number
  readonly tokensOut?: number
}

type Freshness = "live" | "last" | "pending"

function metricBar(value: number, max: number, width: number): string {
  const filled = Math.max(1, Math.min(width, Math.round((value / max) * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function BarMetric(props: {
  readonly label: string
  readonly value: string
  readonly filled: number
  readonly width: number
  readonly color: (theme: Palette) => RGBA
  readonly theme: () => Palette
}) {
  const color = () => props.color(props.theme())
  return (
    <box flexDirection="row" justifyContent="space-between" width="100%" alignItems="center">
      <text fg={props.theme().muted} width={10}>
        {props.label}
      </text>
      <text fg={color()}>{metricBar(props.filled, props.width, props.width)}</text>
      <text fg={color()} width={6}>
        {props.value.padStart(6)}
      </text>
    </box>
  )
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

  return (
    <box>
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
          <box gap={0}>
            <Show when={metrics().tokensPerSecond !== undefined}>
              <BarMetric
                label="Tokens/s"
                value={metrics().tokensPerSecond!.toFixed(1)}
                filled={Math.min(8, Math.max(1, Math.round(metrics().tokensPerSecond! / 10)))}
                width={8}
                color={(value) => value.success}
                theme={theme}
              />
            </Show>
            <Show when={metrics().tokensPerSecond === undefined}>
              <text fg={theme().muted}>
                tool-only step · {formatTokens(metrics().tokensOut ?? 0)} tokens
              </text>
            </Show>
            <Show when={metrics().tokensOut !== undefined && metrics().tokensPerSecond !== undefined}>
              <BarMetric
                label="Output"
                value={formatTokens(metrics().tokensOut!)}
                filled={Math.min(8, Math.max(1, Math.round((metrics().tokensOut ?? 0) / 100)))}
                width={8}
                color={(value) => value.info}
                theme={theme}
              />
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}
