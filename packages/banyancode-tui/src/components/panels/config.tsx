import type { Context } from "@opencode/plugin/tui/context"
import type { AgentInfo, ModelInfo } from "@opencode/client"
import { createMemo, For, onMount, Show } from "solid-js"
import type { BanyanConfig } from "../../data/pending-rpc"
import type { Live } from "../../data/live"
import { palette, type Palette } from "../../theme"
import { usePanelFocus, useRowKeys, type PanelRow } from "./keys"

const THINKING_LEVELS = ["off", "low", "medium", "high", "max", "xhigh", "ultra"] as const
const HIDDEN_FROM_TAB = new Set(["plan"])

interface OverrideView {
  readonly enabled?: boolean
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly thinking?: string
  readonly variant?: string
}

function parseModel(value: string | undefined): OverrideView["model"] {
  if (!value) return undefined
  const index = value.indexOf("/")
  if (index <= 0) return undefined
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

function overridesFromConfig(config: BanyanConfig | undefined): Record<string, OverrideView> {
  const agents = config?.agent
  if (!agents || typeof agents !== "object") return {}
  return Object.fromEntries(
    Object.entries(agents).map(([name, value]) => {
      const model = parseModel(value?.model)
      return [
        name,
        {
          ...(value?.enabled === undefined ? {} : { enabled: value.enabled }),
          ...(model === undefined ? {} : { model }),
          ...(value?.thinking === undefined ? {} : { thinking: value.thinking }),
          ...(value?.variant === undefined ? {} : { variant: value.variant }),
        },
      ]
    }),
  )
}

function summarize(text: string | undefined, max = 80): string {
  if (!text) return ""
  const first = text.split(/[.\n]/)[0]?.trim() ?? ""
  const candidate = first || text.trim()
  if (candidate.length <= max) return candidate
  return candidate.slice(0, max - 1).trimEnd() + "…"
}

function modeColor(mode: string, theme: Palette) {
  if (mode === "primary") return theme.primary
  if (mode === "subagent") return theme.info
  return theme.muted
}

/**
 * Ported from v1 `feature-plugins/tabs/tab-agents.tsx` (the CONFIG tab).
 *
 * Reads overrides from `banyancode.config.get` (already hydrated by
 * `live.core`) and writes through the `banyancode.system` config methods:
 * `config.agentOverride`, `config.agentPrompt`, `config.agentSave`. The system
 * namespace is local to `data/pending-rpc.ts` until the server ships it, so a
 * failed write is reported instead of silently dropped.
 */
export function ConfigView(props: { readonly context: Context; readonly live: Live }) {
  const theme = () => palette(props.context.theme)

  onMount(() => {
    void props.live.core.refresh()
    void props.context.data.location.agent.sync(props.context.location)
    void props.context.data.location.model.sync(props.context.location)
  })

  const agents = createMemo<AgentInfo[]>(() => {
    const live = props.context.data.location.agent.list(props.context.location) ?? []
    return live.filter((agent) => !agent.hidden && !HIDDEN_FROM_TAB.has(agent.name))
  })

  const overrides = createMemo(() => overridesFromConfig(props.live.core.config()))
  const thinkingDefault = createMemo(
    () => props.live.core.config()?.banyancode_thinking_default ?? "medium",
  )

  const orchestrator = createMemo(
    () => agents().find((agent) => agent.mode === "primary") ?? agents().find((agent) => agent.name === "build"),
  )
  const orchestratorName = createMemo(() => {
    const agent = orchestrator()
    if (!agent) return undefined
    return agent.name === "orchestrator" ? agent.name : "orchestrator"
  })
  const subagents = createMemo(() => {
    const primary = orchestrator()
    return agents().filter((agent) => agent !== primary && agent.mode !== "primary")
  })

  const overrideFor = (name: string) => overrides()[name]

  const enabledFor = (name: string) => overrideFor(name)?.enabled ?? true

  const modelFor = (agent: AgentInfo) => {
    const override = overrideFor(agent.name)?.model
    if (override) return override
    if (!agent.model) return undefined
    return { providerID: agent.model.providerID, modelID: agent.model.id }
  }

  const thinkingFor = (name: string) =>
    overrideFor(name)?.thinking ?? overrideFor(name)?.variant ?? thinkingDefault()

  const modelLabel = (agent: AgentInfo) => {
    const model = modelFor(agent)
    return model ? `${model.providerID}/${model.modelID}` : "(default)"
  }

  const notify = (message: string, variant: "info" | "success" | "warning" | "error") =>
    props.context.ui.toast.show({ message, variant })

  const report = (result: { ok: boolean; message?: string }, success: string, name: string) => {
    if (result.ok) notify(success, "success")
    else notify(result.message ?? `Failed to update ${name}`, "error")
  }

  const toggle = async (name: string) => {
    const next = !enabledFor(name)
    report(await props.live.system.agentOverride({ name, enabled: next }), `Saved ${name} override`, name)
  }

  const pickModel = async (agent: AgentInfo) => {
    const models = props.context.data.location.model.list(props.context.location) ?? []
    if (models.length === 0) {
      notify("No models are available yet", "warning")
      return
    }
    const current = modelFor(agent)
    const key = current ? `${current.providerID}/${current.modelID}` : undefined
    const selected = await props.context.ui.dialog.select<string>({
      title: `Model for ${agent.name}`,
      current: key,
      options: models.map((model: ModelInfo) => ({
        title: `${model.providerID}/${model.modelID}`,
        description: model.name,
        value: `${model.providerID}/${model.modelID}`,
      })),
    })
    if (!selected) return
    const model = parseModel(selected)
    if (!model) return
    report(await props.live.system.agentOverride({ name: agent.name, model }), `Saved ${agent.name} override`, agent.name)
  }

  const pickThinking = async (agent: AgentInfo) => {
    const current = thinkingFor(agent.name)
    const selected = await props.context.ui.dialog.select<string>({
      title: `Thinking for ${agent.name}`,
      current,
      options: THINKING_LEVELS.map((level) => ({ title: level, value: level })),
    })
    if (!selected) return
    report(
      await props.live.system.agentOverride({ name: agent.name, thinking: selected }),
      `Saved ${agent.name} override`,
      agent.name,
    )
  }

  const editPrompt = async (agent: AgentInfo) => {
    const current = props.live.core.config()?.agent?.[agent.name]?.prompt ?? agent.system ?? ""
    const value = await props.context.ui.dialog.prompt({
      title: `System prompt for ${agent.name}`,
      value: current,
    })
    if (value === undefined) return
    report(await props.live.system.agentPrompt({ name: agent.name, prompt: value }), `Saved prompt for ${agent.name}`, agent.name)
  }

  const addAgent = async () => {
    const name = await props.context.ui.dialog.prompt({
      title: "New agent name",
      placeholder: "my-agent",
    })
    if (!name) return
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      notify("Agent names allow letters, digits, '.', '_' and '-'", "warning")
      return
    }
    report(
      await props.live.system.agentSave({ name, mode: "subagent", description: "Custom agent" }),
      `Saved agent ${name}`,
      name,
    )
  }

  const focus = usePanelFocus()

  const rows = createMemo<PanelRow[]>(() => {
    const primary = orchestrator()
    const list: PanelRow[] = primary
      ? [
          {
            id: primary.name,
            actions: [
              { title: "Model", run: () => void pickModel(primary) },
              { title: "Thinking", run: () => void pickThinking(primary) },
              { title: "Prompt", run: () => void editPrompt(primary) },
            ],
          },
        ]
      : []
    for (const agent of subagents()) {
      list.push({
        id: agent.name,
        actions: [
          { title: "Toggle", run: () => void toggle(agent.name) },
          { title: "Model", run: () => void pickModel(agent) },
          { title: "Thinking", run: () => void pickThinking(agent) },
          { title: "Prompt", run: () => void editPrompt(agent) },
        ],
      })
    }
    return list
  })
  const keys = useRowKeys({ context: props.context, rows })
  const cursor = (index: number) => focus?.zone() === "content" && keys.row() === index

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <text fg={theme().text}>
          <b>Agents</b>
        </text>
        <text fg={theme().primary} onMouseUp={() => void addAgent()}>
          [+ Add agent]
        </text>
      </box>
      <text fg={theme().muted} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        Built-in and configured agents. Toggle subagents off to remove them from orchestration.
      </text>

      <Show when={props.live.core.availability() === "unavailable"}>
        <text fg={theme().warning} paddingLeft={2}>
          Config RPC is not available on this server; overrides cannot be saved.
        </text>
      </Show>

      <scrollbox id="banyancode.config.list" flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
        <box flexDirection="column" paddingTop={0} gap={0}>
          <Show when={orchestrator()}>
            {(agent) => (
              <>
                <text fg={theme().muted} paddingLeft={2}>
                  <b>ORCHESTRATOR</b>
                </text>
                <box paddingLeft={2} paddingRight={2}>
                  <AgentCard
                    agent={agent()}
                    displayName={orchestratorName() ?? agent().name}
                    theme={theme()}
                    showToggle={false}
                    enabled
                    cursor={cursor(0)}
                    action={keys.action()}
                    actionOffset={0}
                    modelLabel={modelLabel(agent())}
                    thinkingLabel={thinkingFor(agent().name)}
                    onToggle={() => {}}
                    onModel={() => void pickModel(agent())}
                    onThinking={() => void pickThinking(agent())}
                    onPrompt={() => void editPrompt(agent())}
                  />
                </box>
              </>
            )}
          </Show>

          <text fg={theme().muted} paddingLeft={2}>
            <b>SUBAGENTS</b>
          </text>
          <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={0}>
            <For each={subagents()}>
              {(agent, index) => (
                <AgentCard
                  agent={agent}
                  displayName={agent.name}
                  theme={theme()}
                  showToggle
                  enabled={enabledFor(agent.name)}
                  cursor={cursor(index() + (orchestrator() ? 1 : 0))}
                  action={keys.action()}
                  actionOffset={1}
                  modelLabel={modelLabel(agent)}
                  thinkingLabel={thinkingFor(agent.name)}
                  onToggle={() => void toggle(agent.name)}
                  onModel={() => void pickModel(agent)}
                  onThinking={() => void pickThinking(agent)}
                  onPrompt={() => void editPrompt(agent)}
                />
              )}
            </For>
            <Show when={subagents().length === 0}>
              <text fg={theme().muted} paddingTop={1}>
                No subagents configured.
              </text>
            </Show>
          </box>
        </box>
      </scrollbox>
    </box>
  )
}

function AgentCard(props: {
  readonly agent: AgentInfo
  readonly displayName: string
  readonly theme: Palette
  readonly showToggle: boolean
  readonly enabled: boolean
  readonly cursor: boolean
  readonly action: number
  readonly actionOffset: number
  readonly modelLabel: string
  readonly thinkingLabel: string
  readonly onToggle: () => void
  readonly onModel: () => void
  readonly onThinking: () => void
  readonly onPrompt: () => void
}) {
  return (
    <box
      flexDirection="column"
      border={["bottom"]}
      borderColor={props.theme.border}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={props.cursor ? props.theme.primary : modeColor(props.agent.mode, props.theme)}>
          {props.cursor ? "▸" : "●"}
        </text>
        <text fg={props.enabled ? props.theme.text : props.theme.muted}>
          <b>{props.displayName}</b>
        </text>
        <text fg={props.theme.muted}>[{props.agent.mode}]</text>
        <Show when={props.showToggle}>
          <box flexGrow={1} justifyContent="flex-end" flexDirection="row">
            <text
              fg={props.enabled ? props.theme.success : props.theme.muted}
              onMouseUp={props.onToggle}
            >
              [{props.enabled ? "on" : "off"}]
            </text>
          </box>
        </Show>
      </box>
      <text fg={props.theme.primary} wrapMode="none" truncate>
        {summarize(props.agent.description)}
      </text>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={props.theme.muted}>Model</text>
        <text
          fg={props.cursor && props.action === props.actionOffset ? props.theme.primary : props.theme.info}
          onMouseUp={props.onModel}
        >
          {props.modelLabel} ▾
        </text>
        <text fg={props.theme.muted}>· Thinking</text>
        <text
          fg={props.cursor && props.action === props.actionOffset + 1 ? props.theme.primary : props.theme.info}
          onMouseUp={props.onThinking}
        >
          {props.thinkingLabel} ▾
        </text>
        <text fg={props.theme.muted}>· Prompt</text>
        <text
          fg={props.cursor && props.action === props.actionOffset + 2 ? props.theme.primary : props.theme.info}
          onMouseUp={props.onPrompt}
        >
          edit system prompt
        </text>
      </box>
    </box>
  )
}
