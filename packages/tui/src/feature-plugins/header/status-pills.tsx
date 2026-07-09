/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"
import { pillFill, type Severity } from "../../util/palette"
import { RoundedBorder } from "../../ui/border"

export * as HeaderStatusPills from "./status-pills"

const id = "internal:header-status-pills"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [activeSessionCount, setActiveSessionCount] = createSignal<number>(0)
  const [graphBuilt, setGraphBuilt] = createSignal<boolean>(false)

  const ev = useEvent()
  const unsubSession = ev.on("session.updated" as any, () => refreshSessionCount())
  onCleanup(unsubSession)

  const unsubGraph = ev.on("banyancode.codegraph.build" as any, (evt: any) => {
    if (evt.properties?.status === "completed") {
      setGraphBuilt(true)
    }
  })
  onCleanup(unsubGraph)

  const checkGraph = async () => {
    try {
      const nodesResult = await props.api.client.global.codegraph.nodes()
      const hasNodes = (nodesResult.data?.nodes?.length ?? 0) > 0
      setGraphBuilt(hasNodes)
    } catch {
      setGraphBuilt(false)
    }
  }

  const refreshSessionCount = async () => {
    try {
      const list = await props.api.client.session.list({})
      const sessions = list.data ?? []
      const statuses = (props.api.state as any).session_status ?? {}
      const active = sessions.filter((s: any) => {
        const status = statuses[s.id]
        return status?.type === "busy" || status?.type === "retry"
      }).length
      setActiveSessionCount(active)
    } catch {
      setActiveSessionCount(0)
    }
  }

  onMount(() => {
    refreshSessionCount()
    checkGraph()
  })

  const mcpList = createMemo(() => props.api.state.mcp())
  const mcpConnectedCount = createMemo(() => mcpList().filter((m) => m.status === "connected").length)
  const mcpFirstConnected = createMemo(() => mcpList().find((m: any) => m.status === "connected")?.name ?? "")

  const lspCount = createMemo(() => props.api.state.lsp().length)

  const agentsLabel = () => `${activeSessionCount()} active`
  const mcpLabel = () => (mcpConnectedCount() > 0 ? `MCP: ${mcpFirstConnected()}` : "MCP: —")
  const lspLabel = () => (lspCount() > 0 ? `LSP: ${lspCount()}` : "LSP: off")
  const graphLabel = () => (graphBuilt() ? "Graph: built" : "Graph: off")

  const agentsDotColor = () => (activeSessionCount() > 0 ? toHex(theme().success) : toHex(theme().textMuted))
  const mcpDotColor = () => (mcpConnectedCount() > 0 ? toHex(theme().success) : toHex(theme().error))
  const lspDotColor = () => (lspCount() > 0 ? toHex(theme().success) : toHex(theme().error))
  const graphDotColor = () => (graphBuilt() ? toHex(theme().success) : toHex(theme().error))

  return (
    <box flexDirection="row" gap={2} alignItems="center">
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={agentsDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{agentsLabel()}</text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={mcpDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{mcpLabel()}</text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={lspDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{lspLabel()}</text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={graphDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{graphLabel()}</text>
      </box>
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
