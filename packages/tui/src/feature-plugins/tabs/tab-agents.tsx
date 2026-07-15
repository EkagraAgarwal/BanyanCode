/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import type { TextareaRenderable } from "@opentui/core"
import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import { toHex } from "../../util/color"
import { useDialog } from "../../ui/dialog"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"
import { useEvent } from "../../context/event"
import { RoundedBorder } from "../../ui/border.ts"
import { DialogAgentConfig } from "../../component/dialog-agent-config"
import { DialogModel } from "../../component/dialog-model"

const id = "internal:tab-agents"

const HIDDEN_FROM_TAB = new Set(["plan"])

interface AgentInfo {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  model?: { providerID: string; modelID: string }
  prompt?: string
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const ev = useEvent()
  const [promptDrafts, setPromptDrafts] = createSignal<Record<string, string>>({})
  const [editingPrompt, setEditingPrompt] = createSignal<string | null>(null)

  const notify = (message: string) => {
    void props.api.attention.notify({
      message,
      notification: false,
      sound: false,
    })
  }

  const live = createMemo(() => (sync.data.agent ?? []) as unknown as AgentInfo[])

  const agents = createMemo<AgentInfo[]>(() => {
    const list = live().length > 0 ? live() : builtInAgents()
    return list.filter((a) => !a.hidden && !HIDDEN_FROM_TAB.has(a.name))
  })

  const loadAgentOverrides = async () => {
    try {
      const result = await props.api.client.global.banyanConfig.get({})
      const agents = (result?.data?.agent ?? {}) as Record<string, any>
      return Object.entries(agents).map(([name, conf]) => {
        let model: { providerID: string; modelID: string } | undefined = undefined
        if (conf.model) {
          const parts = conf.model.split('/')
          model = {
            providerID: parts[0],
            modelID: parts.slice(1).join('/')
          }
        }
        return {
          name,
          enabled: conf.enabled,
          model
        }
      })
    } catch {
      return []
    }
  }

  const loadAgentPrompts = async () => {
    try {
      const result = await props.api.client.global.banyanConfig.get({})
      const agents = (result?.data?.agent ?? {}) as Record<string, any>
      return Object.entries(agents)
        .filter(([_, conf]) => conf.prompt !== undefined)
        .map(([name, conf]) => ({
          name,
          prompt: conf.prompt!
        }))
    } catch {
      return []
    }
  }

  const [overridesData, setOverridesData] = createSignal<Array<{ name: string; enabled?: boolean; model?: { providerID: string; modelID: string } }>>([])

  const [promptsData, setPromptsData] = createSignal<Array<{ name: string; prompt: string }>>([])

  const loadOverrides = async () => {
    const [overrides, prompts] = await Promise.all([loadAgentOverrides(), loadAgentPrompts()])
    setOverridesData(overrides)
    setPromptsData(prompts)
  }

  // Subscribe to config-updated events to re-read overrides and prompts
  onCleanup(
    ev.on("banyancode.config.updated" as never, () => {
      void loadOverrides()
    }),
  )

  // Load overrides and prompts on mount
  void loadOverrides()

  const enabledFor = (name: string) => {
    const override = overridesData().find((o) => o.name === name)
    return override?.enabled ?? true
  }

  const modelFor = (name: string) => {
    const override = overridesData().find((o) => o.name === name)
    return override?.model
  }

  const isOn = (name: string) => enabledFor(name)

  const orchestrator = createMemo(() => {
    const list = agents()
    return list.find((a) => a.mode === "primary") ?? list.find((a) => a.name === "build")
  })

  const orchestratorName = createMemo(() => {
    const agent = orchestrator()
    if (!agent) return undefined
    return agent.name === "orchestrator" ? agent.name : "orchestrator"
  })

  const subagents = createMemo(() => {
    const list = agents()
    const primary = orchestrator()
    return list.filter((a) => a !== primary && a.mode !== "primary")
  })

  const toggle = async (name: string) => {
    const currentEnabled = enabledFor(name)
    const nextEnabled = !currentEnabled
    // Optimistic update
    setOverridesData((prev) => {
      const idx = prev.findIndex((o) => o.name === name)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], enabled: nextEnabled }
        return next
      }
      return [...prev, { name, enabled: nextEnabled }]
    })
    try {
      await props.api.client.global.banyanAgentOverride.update({ name, enabled: nextEnabled })
      toast.show({ message: `Saved ${name} override`, variant: "success" })
    } catch {
      // Revert on failure
      setOverridesData((prev) => {
        const idx = prev.findIndex((o) => o.name === name)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], enabled: currentEnabled }
          return next
        }
        return prev
      })
      toast.show({ message: `Failed to update ${name}`, variant: "error" })
    }
  }

  const startEditPrompt = (name: string, current: string) => {
    setPromptDrafts((prev) => ({ ...prev, [name]: current }))
    setEditingPrompt(name)
  }

  const cancelEditPrompt = (name: string) => {
    setPromptDrafts((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    if (editingPrompt() === name) setEditingPrompt(null)
  }

  const saveEditPrompt = async (name: string) => {
    const value = promptDrafts()[name] ?? ""
    try {
      await props.api.client.global.banyanAgentPrompt.update({ name, prompt: value })
      toast.show({ message: `Saved prompt for ${name}`, variant: "success" })
    } catch {
      toast.show({ message: `Failed to save prompt for ${name}`, variant: "error" })
    }
    setEditingPrompt(null)
  }

  const openModelPicker = (name: string) => {
    dialog.replace(() => (
      <DialogModel
        onSelect={(model) => {
          // Optimistic update
          setOverridesData((prev) => {
            const idx = prev.findIndex((o) => o.name === name)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], model }
              return next
            }
            return [...prev, { name, model }]
          })
          // Call endpoint
          ;(async () => {
            try {
              await props.api.client.global.banyanAgentOverride.update({ name, model })
              toast.show({ message: `Saved ${name} override`, variant: "success" })
            } catch (err) {
              // Revert on failure
              setOverridesData((prev) => {
                const idx = prev.findIndex((o) => o.name === name)
                if (idx >= 0) {
                  const next = [...prev]
                  const existing = next[idx]
                  const { model: _model, ...rest } = existing
                  next[idx] = rest
                  return next.filter((o) => Object.keys(o).length > 1)
                }
                return prev
              })
              toast.show({ message: `Failed to update ${name}: ${String(err)}`, variant: "error" })
            }
          })()
        }}
      />
    ))
  }

  const openAddAgent = () => {
    dialog.replace(() => <DialogAgentConfig />)
  }

  const modelLabel = (agent: AgentInfo): string => {
    const override = modelFor(agent.name)
    if (override) return `${override.providerID}/${override.modelID}`
    if (agent.model?.modelID) {
      return agent.model.providerID
        ? `${agent.model.providerID}/${agent.model.modelID}`
        : agent.model.modelID
    }
    return "(default)"
  }

  const promptText = (agent: AgentInfo): string => {
    const draft = promptDrafts()[agent.name]
    if (draft !== undefined) return draft
    const persisted = promptsData().find((p) => p.name === agent.name)
    if (persisted) return persisted.prompt
    return agent.prompt ?? ""
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center" paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={toHex(theme().text)}>
          <b>Agents</b>
        </text>
        <text fg={toHex(theme().primary)} onMouseUp={openAddAgent}>
          [+ Add agent]
        </text>
      </box>
      <text fg={toHex(theme().textMuted)} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        Built-in and configured agents. Toggle subagents off to remove them from orchestration.
      </text>
      <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={0} gap={1}>
          <Show when={orchestrator()}>
            {(prim) => (
              <>
                <GroupLabel label="ORCHESTRATOR" theme={theme()} />
                <box paddingLeft={2} paddingRight={2}>
                  <AgentCard
                    agent={prim()}
                    displayName={orchestratorName() ?? prim().name}
                    theme={theme()}
                    showToggle={false}
                    enabled
                    onToggle={() => {}}
                    modelLabel={modelLabel(prim())}
                    onOpenModel={() => openModelPicker(prim().name)}
                    editingPrompt={editingPrompt() === prim().name}
                    promptValue={promptText(prim())}
                    onStartEditPrompt={() => startEditPrompt(prim().name, promptText(prim()))}
                    onPromptChange={(v) =>
                      setPromptDrafts((prev) => ({ ...prev, [prim().name]: v }))
                    }
                    onSavePrompt={() => void saveEditPrompt(prim().name)}
                    onCancelPrompt={() => cancelEditPrompt(prim().name)}
                  />
                </box>
              </>
            )}
          </Show>
          <GroupLabel label="SUBAGENTS" theme={theme()} />
          <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
            <For each={subagents()}>
              {(agent) => (
                <AgentCard
                  agent={agent}
                  displayName={agent.name}
                  theme={theme()}
                  showToggle
                  enabled={isOn(agent.name)}
                  onToggle={() => toggle(agent.name)}
                  modelLabel={modelLabel(agent)}
                  onOpenModel={() => openModelPicker(agent.name)}
                  editingPrompt={editingPrompt() === agent.name}
                  promptValue={promptText(agent)}
                  onStartEditPrompt={() => startEditPrompt(agent.name, promptText(agent))}
                  onPromptChange={(v) =>
                    setPromptDrafts((prev) => ({ ...prev, [agent.name]: v }))
                  }
                  onSavePrompt={() => void saveEditPrompt(agent.name)}
                  onCancelPrompt={() => cancelEditPrompt(agent.name)}
                />
              )}
            </For>
          </box>
        </box>
      </scrollbox>
    </box>
  )
}

function GroupLabel(props: { label: string; theme: any }) {
  return (
    <text fg={toHex(props.theme.textMuted)} paddingLeft={2} paddingTop={1}>
      <b>{props.label}</b>
    </text>
  )
}

function summarize(text: string | undefined, max = 80): string {
  if (!text) return ""
  const first = text.split(/[.\n]/)[0]?.trim() ?? ""
  const candidate = first || text.trim()
  if (candidate.length <= max) return candidate
  return candidate.slice(0, max - 1).trimEnd() + "…"
}

function AgentCard(props: {
  agent: AgentInfo
  displayName: string
  theme: any
  showToggle: boolean
  enabled: boolean
  onToggle: () => void
  modelLabel: string
  onOpenModel: () => void
  editingPrompt: boolean
  promptValue: string
  onStartEditPrompt: () => void
  onPromptChange: (v: string) => void
  onSavePrompt: () => void
  onCancelPrompt: () => void
}) {
  const titleFg = () => (props.enabled ? toHex(props.theme.text) : toHex(props.theme.textMuted))
  const description = () => summarize(props.agent.description)

  return (
    <box
      flexDirection="column"
      border={["left", "right", "top", "bottom"]}
      borderColor={props.theme.border}
      customBorderChars={RoundedBorder.customBorderChars}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={modeColor(props.agent.mode, props.theme)}>●</text>
        <text fg={titleFg()}>
          <b>{props.displayName}</b>
        </text>
        <text fg={toHex(props.theme.textMuted)}>[{props.agent.mode}]</text>
        <Show when={props.showToggle}>
          <box flexGrow={1} justifyContent="flex-end" flexDirection="row">
            <text
              fg={toHex(props.enabled ? props.theme.success : props.theme.textMuted)}
              onMouseUp={props.onToggle}
            >
              [{props.enabled ? "on" : "off"}]
            </text>
          </box>
        </Show>
      </box>
      <text fg={toHex(props.theme.primary)}>{description()}</text>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={toHex(props.theme.textMuted)}>Model</text>
        <text fg={toHex(props.theme.info)} onMouseUp={props.onOpenModel}>
          {props.modelLabel} ▾
        </text>
      </box>
      <Show
        when={props.editingPrompt}
        fallback={
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={toHex(props.theme.textMuted)}>Prompt</text>
            <text fg={toHex(props.theme.info)} onMouseUp={props.onStartEditPrompt}>
              edit system prompt
            </text>
          </box>
        }
      >
        <box flexDirection="column" gap={1}>
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={toHex(props.theme.textMuted)}>Prompt</text>
            <text fg={toHex(props.theme.textMuted)}>editing</text>
          </box>
          <textarea
            height={4}
            initialValue={props.promptValue}
            onContentChange={(val: any) => props.onPromptChange(val?.plainText ?? props.promptValue)}
            onSubmit={props.onSavePrompt}
            ref={(val: TextareaRenderable) => {
              if (!val) return
              setTimeout(() => val.focus(), 1)
            }}
          />
          <box flexDirection="row" gap={1}>
            <text fg={toHex(props.theme.success)} onMouseUp={props.onSavePrompt}>
              [save]
            </text>
            <text fg={toHex(props.theme.textMuted)} onMouseUp={props.onCancelPrompt}>
              [cancel]
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}

function modeColor(mode: string, theme: any): string {
  if (mode === "primary") return toHex(theme.primary)
  if (mode === "subagent") return toHex(theme.info)
  return toHex(theme.textMuted)
}

function builtInAgents(): AgentInfo[] {
  return [
    { name: "build", mode: "primary", description: "Full access. Decomposes tasks, fans out to subagents." },
    { name: "coder", mode: "subagent", description: "Focused code changes" },
    { name: "explore", mode: "subagent", description: "Fast code exploration" },
    { name: "researcher", mode: "subagent", description: "Web search and external docs" },
    { name: "scout", mode: "subagent", description: "Quick reconnaissance" },
    { name: "general", mode: "subagent", description: "General-purpose agent" },
  ]
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 75,
    slots: {
      session_tab_agents() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin