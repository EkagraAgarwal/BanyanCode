/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"

const id = "internal:sidebar-performance"

interface StepMetrics {
  stepId: string
  ttftMs?: number
  tokensPerSecond?: number
  latencyMs?: number
}

function numeric(v: number | "NaN" | "Infinity" | "-Infinity" | undefined): number | undefined {
  if (v === undefined || v === "NaN" || !isFinite(v as number)) return undefined
  return v as number
}

function BarMetric(props: {
  label: string
  value: string
  fillPercent: number
  color: "primary" | "success" | "info" | "warning"
  theme: () => any
}) {
  const width = 12
  const filled = Math.round((props.fillPercent / 100) * width)
  const bar = "█".repeat(filled) + "░".repeat(width - filled)

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
      <box flexDirection="row" gap={0}>
        <text fg={colorFn()}>{bar}</text>
      </box>
    </box>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()

  const [steps, setSteps] = createSignal<StepMetrics[]>([])

  const MAX_STEPS = 3

  const unsub = ev.on("session.next.step.ended", (event) => {
    const tps = numeric(event.properties.tokensPerSecond)
    const latency = event.properties.tokens.output > 0 && tps ? event.properties.tokens.output / tps * 1000 : undefined
    setSteps((prev) => {
      const next = [
        {
          stepId: event.properties.assistantMessageID,
          ttftMs: numeric(event.properties.ttftMs),
          tokensPerSecond: tps,
          latencyMs: latency,
        },
        ...prev,
      ]
      return next.slice(0, MAX_STEPS)
    })
  })
  onCleanup(unsub)

  const peakTps = createMemo(() => Math.max(...steps().map((s) => s.tokensPerSecond ?? 0), 0))
  const peakTtft = createMemo(() => Math.max(...steps().map((s) => s.ttftMs ?? 0), 0))
  const peakLatency = createMemo(() => Math.max(...steps().map((s) => s.latencyMs ?? 0), 0))

  const recentSteps = createMemo(() => steps().slice(0, MAX_STEPS))

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>PERFORMANCE</b>
      </text>
      <Show
        when={recentSteps().length > 0}
        fallback={
          <text fg={toHex(theme().textMuted)} marginTop={1}>
            Waiting for step data…
          </text>
        }
      >
        <For each={recentSteps()}>
          {(step) => (
            <box marginTop={1} gap={0}>
              <Show when={step.tokensPerSecond !== undefined && peakTps() > 0}>
                <BarMetric
                  label="Tokens/sec"
                  value={step.tokensPerSecond!.toFixed(1)}
                  fillPercent={(step.tokensPerSecond! / peakTps()) * 100}
                  color="success"
                  theme={theme}
                />
              </Show>
              <Show when={step.ttftMs !== undefined && peakTtft() > 0}>
                <BarMetric
                  label="TTFT"
                  value={`${step.ttftMs!.toFixed(0)}ms`}
                  fillPercent={(step.ttftMs! / peakTtft()) * 100}
                  color="warning"
                  theme={theme}
                />
              </Show>
              <Show when={step.latencyMs !== undefined && peakLatency() > 0}>
                <BarMetric
                  label="Latency"
                  value={`${step.latencyMs!.toFixed(0)}ms`}
                  fillPercent={(step.latencyMs! / peakLatency()) * 100}
                  color="info"
                  theme={theme}
                />
              </Show>
            </box>
          )}
        </For>
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
