import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { onMount, createSignal } from "solid-js"

export * as HeaderBrand from "./brand"

const id = "internal:header-brand"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [path, setPath] = createSignal<string>("")

  onMount(() => {
    setPath(props.api.state.path.directory || "workspace")
  })

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme().primary}><b>BANYANCODE</b></text>
      <text fg={theme().textMuted}>{path()}</text>
    </box>
  )
}

const plugin: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      app_top: () => <View api={api} />,
    },
  })
}

export default { id, tui: plugin } satisfies BuiltinTuiPlugin
