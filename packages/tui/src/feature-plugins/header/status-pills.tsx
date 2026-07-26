/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"
import type { Severity } from "../../util/palette"

export * as HeaderStatusPills from "./status-pills"

const id = "internal:header-status-pills"

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [activeSessionCount, setActiveSessionCount] = createSignal<number>(0)
  const [graphBuilt, setGraphBuilt] = createSignal<boolean>(false)
  const [buildStatus, setBuildStatus] = createSignal<"idle" | "running" | "completed" | "failed">("idle")
  const [syncStatus, setSyncStatus] = createSignal<"idle" | "watching" | "draining" | "paused">("idle")
  const [syncPending, setSyncPending] = createSignal<number>(0)

  const ev = useEvent()
  const unsubSession = ev.on("session.updated" as any, () => refreshSessionCount())
  onCleanup(unsubSession)

  const unsubGraph = ev.on("banyancode.codegraph.build" as any, (evt: any) => {
    const status = evt.properties?.status
    if (status === "idle" || status === "running" || status === "completed" || status === "failed") {
      setBuildStatus(status)
    }
    if (status === "cancelled") setBuildStatus("idle")
    if (status === "stuck") setBuildStatus("running")
    if (status === "completed") void checkGraph()
  })
  onCleanup(unsubGraph)

  const unsubSync = ev.on("banyancode.codegraph.auto-update" as any, (evt: any) => {
    const status = evt.properties?.status
    if (status === "idle" || status === "watching" || status === "draining" || status === "paused") {
      setSyncStatus(status)
    }
    setSyncPending(typeof evt.properties?.pending === "number" ? evt.properties.pending : 0)
  })
  onCleanup(unsubSync)

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
  languages: string[]
  inert: boolean
  disabled: boolean
}>)
const lspConnectedCount = createMemo(() => lspList().filter((l) => l.status === "connected" && !l.disabled).length)
const lspEnabled = createMemo(() => {
  const v = props.api.state.banyanConfig?.banyancode_lsp
  return v === true || (typeof v === "object" && v !== null)
})

const agentsLabel = () => `${activeSessionCount()} active`
const mcpLabel = () => (mcpConnectedCount() > 0 ? `MCP: ${mcpFirstConnected()}` : "MCP: —")
const graphState = createMemo<{ label: string; severity: Exclude<Severity, "neutral"> }>(() => {
  if (buildStatus() === "running") return { label: "Graph: building", severity: "info" }
  if (buildStatus() === "failed") return { label: "Graph: build failed", severity: "error" }
  if (syncStatus() === "draining") return { label: `Graph: syncing (${syncPending()})`, severity: "info" }
  if (syncStatus() === "paused") return { label: "Graph: paused", severity: "warning" }
  if (syncStatus() === "watching" && graphBuilt()) return { label: "Graph: built", severity: "success" }
  return { label: "Graph: off", severity: "error" }
})
const graphLabel = () => graphState().label

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
  const graphDotColor = () => toHex(theme()[graphState().severity])

  return (
    <box flexDirection="row" gap={2} alignItems="center">
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={agentsDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{agentsLabel()}</text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={lspDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>LSP</text>
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
