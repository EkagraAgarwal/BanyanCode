/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, onMount } from "solid-js"
import { toHex } from "../../util/color"

export * as HeaderBrand from "./brand"

const id = "internal:header-brand"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  const label = createMemo(() => {
    const dir = props.api.state.path.directory ?? ""
    const parts = dir.split(/[\\/]/).filter(Boolean)
    return parts.at(-1) || "BanyanCode"
  })

  return (
    <box flexDirection="row" gap={2} alignItems="center">
      <text fg={toHex(theme().primary)}>
        <b>BANYANCODE</b>
      </text>
      <text fg={toHex(theme().textMuted)}>{label()}</text>
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
