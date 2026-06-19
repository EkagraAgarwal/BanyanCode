import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

export * as HeaderKeybindingHints from "./keybinding-hints"

const id = "internal:header-keybinding-hints"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  return (
    <text fg={theme().textMuted}>? help  q quit  ctrl+k menu</text>
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
