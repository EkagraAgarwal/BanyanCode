/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createResource, For, Show } from "solid-js"
import { toHex } from "../../util/color"
import { useDialog } from "../../ui/dialog"
import { DialogAgentConfig } from "../../component/dialog-agent-config"

const id = "internal:tab-agents"

interface AgentInfo {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const dialog = useDialog()

  const [agents] = createResource<AgentInfo[]>(async () => {
    try {
      const result = await (props.api.client as any).agent?.list?.({})
      return (result?.data ?? builtInAgents()) as AgentInfo[]
    } catch {
      return builtInAgents()
    }
  })

  const openAgentConfig = () => {
    dialog.replace(() => <DialogAgentConfig />)
  }

  return (
    <scrollbox flexGrow={1} verticalScrollbarOptions={{ visible: true, paddingLeft: 1 }}>
      <box flexDirection="column" paddingTop={1} gap={1}>
        <box flexDirection="row" gap={2}>
          <text fg={toHex(theme().text)}><b>Agents</b></text>
          <text
            fg={toHex(theme().primary)}
            onMouseUp={openAgentConfig}
          >
            [+ Add]
          </text>
        </box>
        <text fg={toHex(theme().textMuted)}>Built-in and configured agents</text>
        <Show when={agents()} fallback={<text fg={toHex(theme().textMuted)}>Loading...</text>}>
          <For each={agents()!.filter((a) => !a.hidden)}>
            {(agent) => (
              <box flexDirection="column" paddingTop={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={modeColor(agent.mode, theme())}>●</text>
                  <text fg={toHex(theme().text)}><b>{agent.name}</b></text>
                  <text fg={toHex(theme().textMuted)}>[{agent.mode}]</text>
                </box>
                <Show when={agent.description}>
                  <text fg={toHex(theme().textMuted)}>{agent.description}</text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
    </scrollbox>
  )
}

function modeColor(mode: string, theme: any): string {
  if (mode === "primary") return toHex(theme.primary)
  if (mode === "subagent") return toHex(theme.info)
  return toHex(theme.textMuted)
}

function builtInAgents(): AgentInfo[] {
  return [
    { name: "orchestrator", mode: "primary", description: "Decomposes tasks, fans out to subagents" },
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
