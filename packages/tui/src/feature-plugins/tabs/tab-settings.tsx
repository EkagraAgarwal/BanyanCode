/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, For, onCleanup } from "solid-js"
import { useToast } from "../../ui/toast"
import { useDialog } from "../../ui/dialog"
import { toHex } from "../../util/color"
import { Accordion } from "../../ui/accordion"
import { ToggleSwitch } from "../../ui/toggle-switch"
import { NumberInput } from "../../ui/number-input"
import { DialogEmbeddingModel } from "../../component/dialog-embedding-model"
import { DialogModel } from "../../component/dialog-model"
import { useLocal } from "../../context/local"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"

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

function ScopeToggle(props: {
  value: "global" | "project"
  onChange: (s: "global" | "project") => void
  theme: any
}) {
  return (
    <box flexDirection="row" gap={1}>
      <text
        fg={props.value === "global" ? toHex(props.theme.primary) : toHex(props.theme.textMuted)}
        onMouseUp={() => props.value !== "global" && props.onChange("global")}
      >
        Global
      </text>
      <text fg={toHex(props.theme.textMuted)}>/</text>
      <text
        fg={props.value === "project" ? toHex(props.theme.primary) : toHex(props.theme.textMuted)}
        onMouseUp={() => props.value !== "project" && props.onChange("project")}
      >
        Project
      </text>
    </box>
  )
}

function MaskedInput(props: {
  label: string
  value: string
  placeholder: string
  onSave: (value: string) => void
  theme: any
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const display = () => (props.value ? "(set)" : props.placeholder)

  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={toHex(props.theme.textMuted)}>{props.label}:</text>
      <text
        fg={toHex(props.theme.text)}
        onMouseUp={() => { setDraft(props.value); setEditing(true) }}
      >
        {display()}
      </text>
      {editing() && (
        <box flexDirection="row" gap={1}>
          <input
            value={draft()}
            onInput={setDraft}
            onSubmit={() => { props.onSave(draft()); setEditing(false) }}
            width={40}
            placeholder={props.placeholder}
          />
          <text
            fg={toHex(props.theme.primary)}
            onMouseUp={() => { props.onSave(draft()); setEditing(false) }}
          >
            save
          </text>
          <text
            fg={toHex(props.theme.textMuted)}
            onMouseUp={() => setEditing(false)}
          >
            esc
          </text>
        </box>
      )}
    </box>
  )
}

type EndpointEntry = {
  name: string
  base_url: string
  api_key?: string
  models?: string[]
}

function EndpointsSection(props: { api: TuiPluginApi; config: () => Record<string, any>; theme: () => any; update: (patch: Record<string, any>) => Promise<void> }) {
  const dialog = useDialog()
  const endpoints = () => (props.config().banyancode_openai_compatible_endpoints ?? []) as EndpointEntry[]

  async function saveEndpoints(updated: EndpointEntry[]) {
    await props.update({ banyancode_openai_compatible_endpoints: updated })
  }

  async function removeEndpoint(idx: number) {
    const updated = endpoints().filter((_, i) => i !== idx)
    await saveEndpoints(updated)
  }

  function openEmbeddingPicker() {
    dialog.replace(() => <DialogEmbeddingModel />)
  }

  return (
    <>
      <text fg={toHex(props.theme().textMuted)}>
        {endpoints().length} endpoint{endpoints().length !== 1 ? "s" : ""} configured
      </text>
      <For each={endpoints()}>{(ep, idx) => (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          <text fg={toHex(props.theme().text)}>
            {ep.name} — {ep.base_url}
          </text>
          <text
            fg={toHex(props.theme().error)}
            onMouseUp={() => removeEndpoint(idx())}
          >
            [remove]
          </text>
        </box>
      )}</For>
      <box marginTop={1}>
        <LinkText
          text="[open /embedding-model picker to add endpoints]"
          theme={props.theme()}
          onClick={openEmbeddingPicker}
        />
      </box>
    </>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const toast = useToast()
  const dialog = useDialog()
  const local = useLocal()
  const sync = useSync()
  const ev = useEvent()

  const [scope, setScope] = createSignal<"global" | "project">("global")

  const [config, setConfig] = createSignal<Record<string, any>>({})

  const loadConfig = async () => {
    try {
      const result = await props.api.client.global.banyanConfig.get({})
      setConfig(result?.data ?? {})
    } catch {
      setConfig({})
    }
  }
  void loadConfig()

  // Subscribe to config-related events to re-read BanyanConfig
  onCleanup(
    ev.on("banyancode.config.updated" as any, () => {
      void loadConfig()
    }),
  )
  onCleanup(
    ev.on("embedding.model.applied" as any, () => {
      void loadConfig()
    }),
  )

  // Live values sourced from reactive stores
  const currentModel = () => local.model.current()
  const currentAgent = () => local.agent.current()

  const update = async (patch: Record<string, any>, chosenScope?: "global" | "project") => {
    const s = chosenScope ?? scope()
    try {
      await props.api.client.global.banyanConfig.update({
        config: patch,
        scope: s,
      })
      await loadConfig()
      toast.show({ message: "Setting saved", variant: "success" })
    } catch (e) {
      toast.show({ message: `Save failed: ${String(e)}`, variant: "error" })
    }
  }

  const openEmbeddingPicker = () => {
    dialog.replace(() => <DialogEmbeddingModel />)
  }

  const openModelPicker = () => {
    dialog.replace(() => <DialogModel />)
  }

  const modelDisplay = () => {
    const m = currentModel()
    return m ? `${m.providerID} / ${m.modelID}` : "—"
  }

  const agentDisplay = () => currentAgent()?.name ?? "—"

  const defaultAgent = () => sync.data.config.default_agent ?? "—"

  const cfg = () => config()
  const maxSubagents = () => cfg().banyancode_max_subagents ?? 5
  const yoloMode = () => cfg().banyancode_yolo_mode ?? false
  const disableWebsearch = () => cfg().banyancode_disable_websearch ?? false

  const embeddingModel = () => cfg().banyancode_embedding_model ?? "—"
  const embeddingDim = () => cfg().banyancode_embedding_dim
  const embeddingType = () => cfg().banyancode_embedding_type ?? "F32"

  const telegramEnabled = () => cfg().banyancode_telegram_enabled ?? false
  const telegramBotToken = () => cfg().banyancode_telegram_bot_token ?? ""
  const telegramWebhookSecret = () => cfg().banyancode_telegram_webhook_secret ?? ""
  const telegramDefaultSession = () => cfg().banyancode_telegram_default_session ?? "—"

  const subagentCount = () => (cfg().banyancode_subagents ?? []).length

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <text fg={toHex(theme().text)}><b>Settings</b></text>
          <ScopeToggle value={scope()} onChange={setScope} theme={theme()} />
        </box>

        <Accordion
          theme={theme()}
          defaultOpen="model"
          sections={[
            {
              id: "model",
              title: "Model & Provider",
              content: () => (
                <>
                  <SettingRow
                    label="Current Model"
                    value={modelDisplay()}
                    theme={theme()}
                  />
                  <box marginTop={1}>
                    <LinkText
                      text="[change model]"
                      theme={theme()}
                      onClick={openModelPicker}
                    />
                  </box>
                  <SettingRow label="Current Agent" value={agentDisplay()} theme={theme()} />
                  <SettingRow label="Default Agent" value={defaultAgent()} theme={theme()} />
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
                    value={maxSubagents()}
                    onChange={(v) => update({ banyancode_max_subagents: v })}
                    label="Max Subagents"
                    min={1}
                    max={20}
                  />
                  <text fg={toHex(theme().textMuted)}>Default: 5, max: 20</text>

                  <box marginTop={1}>
                    <ToggleSwitch
                      theme={theme()}
                      value={yoloMode()}
                      onChange={(v) => update({ banyancode_yolo_mode: v })}
                      label="YOLO Mode (auto-approve all permissions)"
                    />
                  </box>

                  <box marginTop={1}>
                    <ToggleSwitch
                      theme={theme()}
                      value={disableWebsearch()}
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
                    value={embeddingModel()}
                    theme={theme()}
                  />
                  <SettingRow
                    label="Dimension"
                    value={embeddingDim() != null ? String(embeddingDim()) : "—"}
                    theme={theme()}
                  />
                  <SettingRow
                    label="Type"
                    value={embeddingType()}
                    theme={theme()}
                  />
                  <box marginTop={1}>
                    <LinkText
                      text="[change embedding model]"
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
                <EndpointsSection
                  api={props.api}
                  config={config}
                  theme={theme}
                  update={update}
                />
              ),
            },
            {
              id: "telegram",
              title: "Telegram Bot",
              content: () => (
                <>
                  <ToggleSwitch
                    theme={theme()}
                    value={telegramEnabled()}
                    onChange={(v) => update({ banyancode_telegram_enabled: v })}
                    label="Enabled"
                  />
                  <MaskedInput
                    label="Bot Token"
                    value={telegramBotToken()}
                    placeholder="(not set)"
                    onSave={(v) => update({ banyancode_telegram_bot_token: v })}
                    theme={theme()}
                  />
                  <MaskedInput
                    label="Webhook Secret"
                    value={telegramWebhookSecret()}
                    placeholder="(not set)"
                    onSave={(v) => update({ banyancode_telegram_webhook_secret: v })}
                    theme={theme()}
                  />
                  <SettingRow
                    label="Default Session"
                    value={telegramDefaultSession() || "—"}
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
                    {subagentCount()} configured
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
