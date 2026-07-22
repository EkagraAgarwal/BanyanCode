/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"

const id = "internal:sidebar-performance"

interface StepMetrics {
  source: string
  ttftMs: number | undefined
  tokensPerSecond: number | undefined
  tokensOut: number | undefined
}

// TUI-side classification of step freshness. Drives the visual cue so a
// reader can tell at a glance whether TPS is from the current in-flight step
// or just the last completed one.
type StepFreshness = "live" | "last" | "pending"

function numeric(v: number | "NaN" | "Infinity" | "-Infinity" | undefined): number | undefined {
  if (v === undefined || v === "NaN" || !Number.isFinite(v as number)) return undefined
  return v as number
}

function BarMetric(props: {
  label: string
  value: string
  filled: number
  width: number
  color: "primary" | "success" | "info" | "warning"
  theme: () => any
}) {
  const filled = Math.max(0, Math.min(props.width, Math.round(props.filled)))
  const bar = "█".repeat(filled) + "░".repeat(props.width - filled)

  const colorFn = () => {
    const t = props.theme()
    if (props.color === "success") return toHex(t.success)
    if (props.color === "info") return toHex(t.info)
    if (props.color === "warning") return toHex(t.warning)
    return toHex(t.primary)
  }

  return (
    <box flexDirection="row" justifyContent="space-between" width="100%" marginTop={0} alignItems="center">
      <text fg={toHex(props.theme().textMuted)} width={10}>{props.label}</text>
      <text fg={colorFn()}>{bar}</text>
      <text fg={colorFn()} width={6}>{props.value.padStart(6)}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()
  const sync = useSync()

  // The last completed step's metrics. May be from a previous turn.
  const [step, setStep] = createSignal<StepMetrics | undefined>(undefined)
  // The assistantMessageID of the step currently being generated (set on
  // step.started). Drives the live/last distinction.
  const [liveSource, setLiveSource] = createSignal<string | undefined>(undefined)
  // When the most recent step was the live one — meaning it ended during this
  // step. Cleared on the next step.started.
  const [liveFresh, setLiveFresh] = createSignal<boolean>(false)

  const lastAssistant = createMemo(() => {
    const messages = sync.data.message[props.session_id] ?? []
    return messages.findLast(
      (m: any) =>
        ((m as any).type === "assistant" || m.role === "assistant") && (m as any).time?.completed,
    )
  })

  const lastAssistantInProgress = createMemo(() => {
    const messages = sync.data.message[props.session_id] ?? []
    return messages.findLast(
      (m: any) =>
        ((m as any).type === "assistant" || m.role === "assistant") && !(m as any).time?.completed,
    )
  })

  const tokensPerSecondFallback = createMemo(() => {
    const last = lastAssistant()
    if (!last || !(last as any).time?.completed || !(last as any).time?.created) return undefined
    const durationMs = (last as any).time.completed - (last as any).time.created
    if (durationMs <= 0 || !(last as any).tokens?.output) return undefined
    return ((last as any).tokens.output / durationMs) * 1000
  })

  const activeStep = createMemo<StepMetrics | undefined>(() => {
    const current = step()
    if (current && current.source) {
      const messages = sync.data.message[props.session_id] ?? []
      if (messages.some((m: any) => m.id === current.source)) {
        return current
      }
    }
    const last = lastAssistant()
    if (last) {
      const tps = tokensPerSecondFallback()
      return {
        source: last.id,
        ttftMs: undefined,
        tokensPerSecond: tps,
        tokensOut: (last as any).tokens?.output,
      }
    }
    return undefined
  })

  // Freshness:
  //   live    — an assistant is currently in-flight and we have NOT yet
  //             received a step.ended for it (TPS not yet known, but bar
  //             still shows the previous step's value with a "pending" cue).
  //   live    — the most recent step.ended arrived during the current step.
  //   last    — the agent is idle and we are showing the previous step.
  //   pending — no completed assistant yet (initial state).
  const freshness = createMemo<StepFreshness>(() => {
    const s = step()
    const live = liveSource()
    const inFlight = lastAssistantInProgress()
    if (!s) return inFlight ? "pending" : "pending"
    if (inFlight && live && live !== s.source) return "pending"
    if (liveFresh()) return "live"
    return "last"
  })

  const unsubStart = ev.on("session.next.step.started", (event: any) => {
    if (event.properties.sessionID !== props.session_id) return
    setLiveSource(event.properties.assistantMessageID)
    setLiveFresh(false)
  })
  const unsubEnd = ev.on("session.next.step.ended", (event: any) => {
    if (event.properties.sessionID !== props.session_id) return
    const aid = event.properties.assistantMessageID
    setStep({
      source: aid,
      ttftMs: numeric(event.properties.ttftMs),
      tokensPerSecond: numeric(event.properties.tokensPerSecond),
      tokensOut: event.properties.tokens?.output,
    })
    if (liveSource() === aid) {
      setLiveFresh(true)
      setLiveSource(undefined)
    }
  })
  onCleanup(() => {
    unsubStart()
    unsubEnd()
  })

  const cueLabel = () => {
    const f = freshness()
    if (f === "live") return "now"
    if (f === "last") return "last"
    return "—"
  }

  return (
    <box>
      <box flexDirection="row" gap={1} alignItems="center" marginTop={0}>
        <text fg={toHex(theme().primary)}>
          <b>PERFORMANCE</b>
        </text>
        <Show when={activeStep() && freshness() !== "pending"}>
          <text fg={toHex(theme().textMuted)}>{cueLabel()}</text>
        </Show>
      </box>
      <Show
        when={activeStep()}
        fallback={
          <text fg={toHex(theme().textMuted)} marginTop={0}>
            step metrics after first turn
          </text>
        }
      >
        {(s) => (
          <box marginTop={0} gap={0}>
            <Show when={s().ttftMs !== undefined}>
              <BarMetric
                label="TTFT"
                value={`${s().ttftMs!.toFixed(0)}ms`}
                filled={Math.min(8, Math.max(1, Math.round((s().ttftMs! ?? 0) / 500)))}
                width={8}
                color="warning"
                theme={theme}
              />
            </Show>
            <Show when={s().tokensPerSecond !== undefined}>
              <BarMetric
                label="Tokens / sec"
                value={s().tokensPerSecond!.toFixed(1)}
                filled={Math.min(8, Math.max(1, Math.round(s().tokensPerSecond! / 10)))}
                width={8}
                color="success"
                theme={theme}
              />
            </Show>
            <Show when={s().ttftMs === undefined && s().tokensPerSecond === undefined}>
              <text fg={toHex(theme().textMuted)}>
                tool-only step · {(s().tokensOut ?? 0).toLocaleString()} tokens
              </text>
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
