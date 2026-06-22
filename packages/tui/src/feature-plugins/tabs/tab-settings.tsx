/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, createSignal } from "solid-js"
import { useToast } from "../../ui/toast"
import { useDialog } from "../../ui/dialog"
import { toHex } from "../../util/color"
import { Accordion } from "../../ui/accordion"
import { ToggleSwitch } from "../../ui/toggle-switch"
import { NumberInput } from "../../ui/number-input"
import { EmbeddingPickerView } from "../../routes/embedding-picker"

const id = "internal:tab-settings"

function SettingRow(props: { label: string; value: string; theme: any }) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={toHex(props.theme.textMuted)}>{props.label}:</text>
      <text>{props.value}</text>
    </box>
  )
}

function LinkText(props: { text: string; theme: any; onClick: () => void }) {
  return (
    <text
      fg={toHex(props.theme.primary)}
      onMouseUp={(e) => { if (e.button === 0) props.onClick() }}
    >
      {props.text}
    </text>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const toast = useToast()
  const dialog = useDialog()

  const [config, setConfig] = createSignal<Record<string, any>>({})

  const loadConfig = async () => {
    try {
      const result = await (props.api.client as any).global?.banyanConfig?.get?.({})
      setConfig(result?.data?.banyanConfig ?? result?.data ?? {})
    } catch {}
  }

  createResource(() => null, loadConfig)

  const update = async (patch: Record<string, any>) => {
    try {
      await (props.api.client as any).global?.banyanConfig?.update?.({
        banyanConfig: patch,
      })
      setConfig({ ...config(), ...patch })
      toast.show({ message: "Setting saved", variant: "success" })
    } catch (e) {
      toast.show({ message: `Save failed: ${String(e)}`, variant: "error" })
    }
  }

  const openEmbeddingPicker = () => {
    dialog.replace(() => <EmbeddingPickerView />)
  }

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
        <text fg={toHex(theme().text)}><b>Settings</b></text>

        <Accordion
          theme={theme()}
          defaultOpen="orchestration"
          sections={[
            {
              id: "model",
              title: "Model & Provider",
              content: () => (
                <>
                  <SettingRow
                    label="Current Model"
                    value={`${config().providerID ?? "—"} / ${config().modelID ?? "—"}`}
                    theme={theme()}
                  />
                  <SettingRow label="Current Agent" value={config().agent ?? "—"} theme={theme()} />
                </>
              ),
            },
            {
              id: "orchestration",
              title: "Orchestration",
              content: () => (
                <>
                  <NumberInput
                    theme={theme()}
                    value={config().banyancode_max_subagents ?? 5}
                    onChange={(v) => update({ banyancode_max_subagents: v })}
                    label="Max Subagents"
                    min={1}
                    max={20}
                  />
                  <text fg={toHex(theme().textMuted)}>Default: 5, max: 20</text>

                  <box marginTop={1}>
                    <ToggleSwitch
                      theme={theme()}
                      value={config().banyancode_yolo_mode ?? false}
                      onChange={(v) => update({ banyancode_yolo_mode: v })}
                      label="YOLO Mode (auto-approve all permissions)"
                    />
                  </box>

                  <box marginTop={1}>
                    <ToggleSwitch
                      theme={theme()}
                      value={config().banyancode_disable_websearch ?? false}
                      onChange={(v) => update({ banyancode_disable_websearch: v })}
                      label="Disable Web Search"
                    />
                  </box>
                </>
              ),
            },
            {
              id: "embeddings",
              title: "Embeddings",
              content: () => (
                <>
                  <SettingRow
                    label="Embedding Model"
                    value={config().banyancode_embedding_model ?? "—"}
                    theme={theme()}
                  />
                  <SettingRow
                    label="Dimension"
                    value={String(config().banyancode_embedding_dim ?? "—")}
                    theme={theme()}
                  />
                  <SettingRow
                    label="Type"
                    value={config().banyancode_embedding_type ?? "F32"}
                    theme={theme()}
                  />
                  <box marginTop={1}>
                    <LinkText
                      text="[run /embedding-model to change]"
                      theme={theme()}
                      onClick={openEmbeddingPicker}
                    />
                  </box>
                </>
              ),
            },
            {
              id: "endpoints",
              title: "OpenAI-Compatible Endpoints",
              content: () => (
                <>
                  <text fg={toHex(theme().textMuted)}>
                    {config().banyancode_openai_compatible_endpoints?.length ?? 0} endpoints configured
                  </text>
                  <box marginTop={1}>
                    <LinkText
                      text="[open /embedding-model picker to manage]"
                      theme={theme()}
                      onClick={openEmbeddingPicker}
                    />
                  </box>
                </>
              ),
            },
            {
              id: "telegram",
              title: "Telegram Bot",
              content: () => (
                <>
                  <ToggleSwitch
                    theme={theme()}
                    value={config().banyancode_telegram_enabled ?? false}
                    onChange={(v) => update({ banyancode_telegram_enabled: v })}
                    label="Enabled"
                  />
                  <SettingRow
                    label="Bot Token"
                    value={config().banyancode_telegram_bot_token ? "(set)" : "(not set)"}
                    theme={theme()}
                  />
                  <SettingRow
                    label="Webhook Secret"
                    value={config().banyancode_telegram_webhook_secret ? "(set)" : "(not set)"}
                    theme={theme()}
                  />
                  <SettingRow
                    label="Default Session"
                    value={config().banyancode_telegram_default_session ?? "—"}
                    theme={theme()}
                  />
                </>
              ),
            },
            {
              id: "subagents",
              title: "Custom Subagents",
              content: () => (
                <>
                  <text fg={toHex(theme().textMuted)}>
                    {config().banyancode_subagents?.length ?? 0} configured
                  </text>
                  <box marginTop={1}>
                    <text fg={toHex(theme().primary)}>[open Agents tab to add or edit]</text>
                  </box>
                </>
              ),
            },
          ]}
        />
      </box>
    </scrollbox>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: {
      session_tab_settings() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
