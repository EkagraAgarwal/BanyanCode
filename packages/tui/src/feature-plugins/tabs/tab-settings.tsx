import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { DialogModel } from "../../component/dialog-model"
import { DialogAgent } from "../../component/dialog-agent"
import { DialogVariant } from "../../component/dialog-variant"
import { useDialog } from "../../ui/dialog"
import { useLocal } from "../../context/local"

const id = "internal:tabs-tab-settings"

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const a = color.a !== undefined ? Math.round(color.a * 255).toString(16).padStart(2, "0") : ""
  return `#${color.r.toString(16).padStart(2, "0")}${color.g.toString(16).padStart(2, "0")}${color.b.toString(16).padStart(2, "0")}${a}`
}

function SettingsRow(props: { label: string; value: string; onEdit: () => void; theme: () => TuiThemeCurrent }) {
  return (
    <box flexDirection="row" gap={2} marginTop={1} onMouseDown={props.onEdit}>
      <text fg={toHex(props.theme().textMuted)} width={12}>
        {props.label}
      </text>
      <text fg={toHex(props.theme().text)}>{props.value}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const local = useLocal()
  const dialog = useDialog()

  const currentModel = () => {
    const m = local.model.current()
    return m ? `${m.providerID}/${m.modelID}` : "—"
  }

  const currentAgent = () => local.agent.current()?.name ?? "—"

  const currentVariant = () => local.model.variant.selected() ?? "default"

  const handleEditModel = () => {
    dialog.replace(() => <DialogModel />)
  }

  const handleEditAgent = () => {
    dialog.replace(() => <DialogAgent />)
  }

  const handleEditVariant = () => {
    dialog.replace(() => <DialogVariant />)
  }

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1}>
        <text fg={toHex(theme().text)}>
          <b>Session Settings</b>
        </text>
        <text fg={toHex(theme().textMuted)} marginTop={1}>
          Click a setting to change it.
        </text>

        <SettingsRow
          label="Model"
          value={currentModel()}
          onEdit={handleEditModel}
          theme={theme}
        />
        <SettingsRow
          label="Agent"
          value={currentAgent()}
          onEdit={handleEditAgent}
          theme={theme}
        />
        <SettingsRow
          label="Variant"
          value={currentVariant()}
          onEdit={handleEditVariant}
          theme={theme}
        />
      </box>
    </scrollbox>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
    slots: {
      session_tab_settings() {
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
