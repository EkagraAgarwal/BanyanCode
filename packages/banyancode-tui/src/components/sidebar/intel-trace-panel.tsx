import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { IntelLive } from "../../data/live"
import type { TraceRow } from "../../data/pending-rpc"
import { palette } from "../../theme"

const REFRESH_DEBOUNCE_MS = 250

function formatRow(row: TraceRow): string {
  return `${row.tool}: ${row.inputSummary} → ${row.resultSummary} (${row.ms ?? "-"}ms)`
}

/**
 * Ported from v1 `sidebar/intel-trace-panel.tsx`. The trace endpoint never
 * shipped in v1; the placeholder `banyancode.intel.trace` method keeps the
 * panel honest — it renders "not available" until the server registers it.
 */
export function IntelTracePanel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly intel: IntelLive
}) {
  const theme = () => palette(props.context.theme)
  const [rows, setRows] = createSignal<readonly TraceRow[]>([])

  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async () => {
    const result = await props.intel.trace(props.sessionID)
    if (result) setRows(result)
  }

  onMount(() => {
    void refresh()
  })

  const off = props.context.data.on("session.tool.called", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS)
  })
  onCleanup(() => {
    off()
    if (timer) clearTimeout(timer)
  })

  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme().primary}>
        <b>TRACE</b>
      </text>
      <Show when={props.intel.traceAvailability() === "unavailable"}>
        <text fg={theme().muted}>Trace panel will populate once the trace endpoint ships.</text>
      </Show>
      <Show when={props.intel.traceAvailability() !== "unavailable" && rows().length === 0}>
        <text fg={theme().muted}>No traces recorded yet for this session.</text>
      </Show>
      <Show when={rows().length > 0}>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme().muted}>{row.tool}</text>
              <text fg={theme().text}>{formatRow(row)}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
