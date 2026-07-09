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
    <box marginTop={1} gap={0}>
      <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
        <text fg={toHex(props.theme().textMuted)}>{props.label}</text>
        <text fg={colorFn()}>{props.value}</text>
      </box>
      <text fg={colorFn()}>{bar}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()
  const sync = useSync()

  const [step, setStep] = createSignal<StepMetrics | undefined>(undefined)

  const total = createMemo(() => {
    const messages = sync.data.message[props.session_id] ?? []
    const assistants = messages.filter((m: any) => m.role === "assistant" && m.time?.completed)
    return assistants.reduce(
      (sum: number, m: any) => sum + (m.tokens?.output ?? 0),
      0,
    )
  })

  const unsub = ev.on("session.next.step.ended", (event: any) => {
    setStep({
      source: event.properties.assistantMessageID,
      ttftMs: numeric(event.properties.ttftMs),
      tokensPerSecond: numeric(event.properties.tokensPerSecond),
      tokensOut: event.properties.tokens?.output,
    })
  })
  onCleanup(unsub)

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>PERFORMANCE</b>
      </text>
      <text fg={toHex(theme().textMuted)} marginTop={1}>
        {total()} tokens generated this session
      </text>
      <Show
        when={step()}
        fallback={
          <text fg={toHex(theme().textMuted)} marginTop={1}>
            step metrics after first turn
          </text>
        }
      >
        {(s) => (
          <box marginTop={1} gap={0}>
            <Show when={s().ttftMs !== undefined}>
              <BarMetric
                label="TTFT"
                value={`${s().ttftMs!.toFixed(0)}ms`}
                filled={Math.min(12, Math.max(1, Math.round((s().ttftMs! ?? 0) / 500)))}
                width={12}
                color="warning"
                theme={theme}
              />
            </Show>
            <Show when={s().tokensPerSecond !== undefined}>
              <BarMetric
                label="Tokens/sec"
                value={s().tokensPerSecond!.toFixed(1)}
                filled={Math.min(12, Math.max(1, Math.round(s().tokensPerSecond! / 10)))}
                width={12}
                color="success"
                theme={theme}
              />
            </Show>
            <Show when={s().ttftMs === undefined && s().tokensPerSecond === undefined}>
              <text fg={toHex(theme().textMuted)}>tool-only step · {(s().tokensOut ?? 0).toLocaleString()} tokens</text>
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
