/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"
import type { Severity } from "../../util/palette"

export * as HeaderStatusPills from "./status-pills"

const id = "internal:header-status-pills"

export function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [activeSessionCount, setActiveSessionCount] = createSignal<number>(0)
  const [lastBuildStatus, setLastBuildStatus] = createSignal<"idle" | "running" | "completed" | "failed">("idle")
  const [lastBuildMeta, setLastBuildMeta] = createSignal({
    graphVersion: 0,
    graphCoverage: 0,
    graphBuiltAt: 0,
    totalFiles: 0,
  })
  const [syncStatus, setSyncStatus] = createSignal<"idle" | "watching" | "draining" | "paused">("idle")
  const [syncPending, setSyncPending] = createSignal<number>(0)

  const ev = useEvent()
  const unsubSession = ev.on("session.updated" as any, () => refreshSessionCount())
  onCleanup(unsubSession)

  const unsubGraph = ev.on("banyancode.codegraph.build" as any, (evt: any) => {
    const status = evt.properties?.status
    if (status === "idle" || status === "running" || status === "completed" || status === "failed") {
      setLastBuildStatus(status)
    }
    if (status === "cancelled") setLastBuildStatus("idle")
    if (status === "stuck") setLastBuildStatus("running")
    setLastBuildMeta((meta) => ({
      graphVersion: typeof evt.properties?.graphVersion === "number" ? evt.properties.graphVersion : meta.graphVersion,
      graphCoverage: typeof evt.properties?.graphCoverage === "number" ? evt.properties.graphCoverage : meta.graphCoverage,
      graphBuiltAt:
        typeof evt.properties?.graphBuiltAt === "number" || typeof evt.properties?.graphBuiltAt === "string"
          ? new Date(evt.properties.graphBuiltAt).getTime()
          : meta.graphBuiltAt,
      totalFiles: typeof evt.properties?.totalFiles === "number" ? evt.properties.totalFiles : meta.totalFiles,
    }))
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
  if ((props.api.state.banyanConfig as any)?.banyancode_codegraph_enabled === false) {
    return { label: "Graph: disabled", severity: "error" }
  }
  if (lastBuildStatus() === "running") return { label: "Graph: building", severity: "info" }
  if (lastBuildStatus() === "failed") return { label: "Graph: build failed", severity: "error" }
  if (syncStatus() === "draining" && syncPending() > 0) {
    return { label: `Graph: syncing (${syncPending()})`, severity: "info" }
  }
  if (syncStatus() === "paused") return { label: "Graph: paused", severity: "warning" }
  const meta = lastBuildMeta()
  const hasGraph = meta.graphVersion > 0 && meta.totalFiles > 0
  const oldAndIdle =
    meta.graphBuiltAt > 0 && Date.now() - meta.graphBuiltAt > 24 * 60 * 60 * 1000 && syncStatus() === "idle"
  if (hasGraph && (meta.graphCoverage < 0.5 || oldAndIdle)) {
    return { label: "Graph: stale", severity: "warning" }
  }
  if (hasGraph && meta.graphCoverage >= 0.5 && lastBuildStatus() === "completed") {
    return { label: "Graph: built", severity: "success" }
  }
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
