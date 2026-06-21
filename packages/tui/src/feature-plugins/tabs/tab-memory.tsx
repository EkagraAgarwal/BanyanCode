import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, For, onMount } from "solid-js"

const id = "internal:tabs-tab-memory"

interface MemoryEntry {
  id: string
  key: string
  version: number
  agentID?: string
  value: unknown
}

import { toHex } from "../../util/color"

function previewValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 40)
  if (typeof value === "object") return JSON.stringify(value).slice(0, 40)
  return String(value).slice(0, 40)
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [entries, setEntries] = createSignal<MemoryEntry[]>([])
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      // (api.client as any).memory?.list() — use as any until SDK is regenerated
      const result = await (props.api.client as any).memory?.list?.({ scope: "global" })
      if (result?.data) {
        setEntries(result.data as MemoryEntry[])
      }
    } catch {
      // stub — no memory SDK API yet
    } finally {
      setLoading(false)
    }
  })

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1}>
        <text fg={toHex(theme().text)}>
          <b>Memory</b>
        </text>
        {loading() ? (
          <text fg={toHex(theme().textMuted)}>Loading...</text>
        ) : entries().length === 0 ? (
          <text fg={toHex(theme().textMuted)}>No memory entries.</text>
        ) : (
          <For each={entries()}>
            {(entry) => (
              <box flexDirection="row" gap={2} marginTop={1}>
                <text fg={toHex(theme().primary)} wrapMode="word" width={20}>
                  {entry.key}
                </text>
                <text fg={toHex(theme().textMuted)} width={8}>
                  v{entry.version}
                </text>
                <text fg={toHex(theme().textMuted)} width={10} truncate>
                  {entry.agentID ?? "—"}
                </text>
                <text fg={toHex(theme().text)} truncate>
                  {previewValue(entry.value)}
                </text>
              </box>
            )}
          </For>
        )}
      </box>
    </scrollbox>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 30,
    slots: {
      session_tab_memory() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
