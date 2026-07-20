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

const lspList = createMemo(() => props.api.state.lsp() as Array<{
    id: string
    name: string
    root: string
    status: "configured" | "connected" | "error"
    autoDownload: boolean
  }>)
  const lspConnectedCount = createMemo(() => lspList().filter((l) => l.status === "connected").length)
  const lspConfiguredCount = createMemo(() => lspList().length)
  const lspAutoDownloadedCount = createMemo(() => lspList().filter((l) => l.autoDownload).length)
  // Configured via banyancode_lsp in banyancode.json. When the service is
  // unavailable (BanyanCode off) or the field is unset, treat LSP as off.
  const lspEnabled = createMemo(() => {
    const cfg = (props.api.state as { banyanConfig?: { banyancode_lsp?: unknown } }).banyanConfig
    const v = cfg?.banyancode_lsp
    return v === true || (typeof v === "object" && v !== null)
  })

  const agentsLabel = () => `${activeSessionCount()} active`
  const mcpLabel = () => (mcpConnectedCount() > 0 ? `MCP: ${mcpFirstConnected()}` : "MCP: —")
  // Show three states: off (config disabled), on-but-nothing-connected
  // (config enabled, no file opened), and active (≥1 server attached).
  const lspLabel = () => {
    if (!lspEnabled()) return "LSP: off"
    if (lspConnectedCount() === 0)
      return `LSP: 0/${lspConfiguredCount()} (idle) · ${lspAutoDownloadedCount()} auto`
    return `LSP: ${lspConnectedCount()}/${lspConfiguredCount()} · ${lspAutoDownloadedCount()} auto`
  }
  const graphLabel = () => (graphBuilt() ? "Graph: built" : "Graph: off")

  const agentsDotColor = () => (activeSessionCount() > 0 ? toHex(theme().success) : toHex(theme().textMuted))
  const mcpDotColor = () => (mcpConnectedCount() > 0 ? toHex(theme().success) : toHex(theme().error))
  // Yellow = config enabled but no servers connected (waiting on a file).
  // Green = at least one server attached. Red = config disabled.
  const lspDotColor = () =>
    !lspEnabled()
      ? toHex(theme().error)
      : lspConnectedCount() > 0
        ? toHex(theme().success)
        : toHex(theme().warning)
  const graphDotColor = () => (graphBuilt() ? toHex(theme().success) : toHex(theme().error))

  return (
    <box flexDirection="row" gap={2} alignItems="center">
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={agentsDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{agentsLabel()}</text>
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
