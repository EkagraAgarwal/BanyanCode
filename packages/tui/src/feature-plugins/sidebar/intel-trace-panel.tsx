/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:sidebar-intel-trace-panel"

type TraceRow = {
  ts: number
  tool: string
  inputSummary: string
  resultSummary: string
  ms?: number
}

type TraceApiClient = {
  global?: {
    trace?: (input: { session: string; limit?: number }) => Promise<{ data?: { events?: TraceRow[] } }>
  }
}

const formatRow = (row: TraceRow) => {
  const ms = typeof row.ms === "number" ? row.ms : "-"
  return `${row.tool}: ${row.inputSummary} → ${row.resultSummary} (${ms}ms)`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [rows, setRows] = createSignal<TraceRow[]>([])
  const [available, setAvailable] = createSignal<boolean | null>(null)

  const refresh = async () => {
    const client = props.api.client as unknown as TraceApiClient
    const trace = client.global?.trace
    if (!trace) {
      setAvailable(false)
      setRows([])
      return
    }
    try {
      const res = await trace({ session: props.session_id, limit: 8 })
      const events = res.data?.events ?? []
      setRows(events)
      setAvailable(true)
    } catch {
      setAvailable(false)
      setRows([])
    }
  }

  onMount(() => {
    refresh()
    let unsub: (() => void) | undefined
    try {
      const bus = props.api.event
      const handler = () => {
        refresh()
      }
      unsub = bus.on("trace.tool.call" as never, handler as never) as () => void
    } catch {}
    onCleanup(() => unsub?.())
  })

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text fg={toHex(theme().text)} attributes={1}>
        Trace
      </text>
      <Show when={available() === false}>
        <text fg={toHex(theme().textMuted)}>Trace panel will populate once the trace endpoint ships.</text>
      </Show>
      <Show when={available() !== false && rows().length === 0}>
        <text fg={toHex(theme().textMuted)}>No traces recorded yet for this session.</text>
      </Show>
      <Show when={rows().length > 0}>
        <For each={rows()}>
          {(row) => (
            <box flexDirection="column" gap={0}>
              <text fg={toHex(theme().textMuted)}>{row.tool}</text>
              <text fg={toHex(theme().text)}>{formatRow(row)}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 157,
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
