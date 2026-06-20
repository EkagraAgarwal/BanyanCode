import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { onMount, createSignal } from "solid-js"

export * as HeaderBrand from "./brand"

const id = "internal:header-brand"

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const toComponent = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v))
  const a = color.a !== undefined ? toComponent(color.a).toString(16).padStart(2, "0") : ""
  return `#${toComponent(color.r).toString(16).padStart(2, "0")}${toComponent(color.g).toString(16).padStart(2, "0")}${toComponent(color.b).toString(16).padStart(2, "0")}${a}`
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [path, setPath] = createSignal<string>("")

  onMount(() => {
    setPath(props.api.state.path.directory || "workspace")
  })

  return (
    <box flexDirection="row" gap={1}>
      <text fg={toHex(theme().primary)}><b>BANYANCODE</b></text>
      <text fg={toHex(theme().textMuted)}>{path()}</text>
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
