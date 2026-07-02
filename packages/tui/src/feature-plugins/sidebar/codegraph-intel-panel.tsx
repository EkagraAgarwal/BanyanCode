/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, For, Show } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:sidebar-codegraph-intel-panel"

type IntelEntry = {
  id: string
  kind: "search" | "subsystem" | "routes"
  query: string
  summary: string
}

const [recentQueries, setRecentQueries] = createSignal<IntelEntry[]>([])

export const pushIntelResult = (entry: IntelEntry) => {
  setRecentQueries((prev) => [entry, ...prev].slice(0, 8))
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const entries = () => recentQueries()

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
      <text fg={toHex(theme().text)} attributes={1}>
        Codegraph Intel
      </text>
      <Show when={entries().length > 0} fallback={<text fg={toHex(theme().textMuted)}>Use /codegraph-search, /repo-find-subsystem, or /codegraph-find-routes.</text>}>
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="column" gap={0}>
              <text fg={toHex(theme().textMuted)}>
                {entry.kind}: {entry.query}
              </text>
              <text fg={toHex(theme().text)}>{entry.summary}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 156,
    slots: {
      sidebar_content() {
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
