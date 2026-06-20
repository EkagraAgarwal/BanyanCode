import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useEvent } from "../../context/event"

export * as HeaderStatusPills from "./status-pills"

const id = "internal:header-status-pills"

interface StalenessState {
  isStale: boolean
  reason?: string
  lastChecked: number
}

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const toComponent = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v))
  const a = color.a !== undefined ? toComponent(color.a).toString(16).padStart(2, "0") : ""
  return `#${toComponent(color.r).toString(16).padStart(2, "0")}${toComponent(color.g).toString(16).padStart(2, "0")}${toComponent(color.b).toString(16).padStart(2, "0")}${a}`
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [staleness, setStaleness] = createSignal<StalenessState | null>(null)
  const [agentCount, setAgentCount] = createSignal<number>(0)

  const ev = useEvent()
  const unsub = ev.on("banyancode.codegraph.staleness" as any, (event: any) => {
    setStaleness({
      isStale: event.properties.isStale,
      reason: event.properties.reason,
      lastChecked: event.properties.lastChecked,
    })
  })
  onCleanup(unsub)

  onMount(async () => {
    const list = await props.api.client.session.list({})
    setAgentCount((list.data?.length ?? 1) - 1)
  })

  const mcpList = createMemo(() => props.api.state.mcp())
  const mcpConnectedCount = createMemo(() => mcpList().filter((m) => m.status === "connected").length)
  const mcpFirstConnected = createMemo(() => mcpList().find((m) => m.status === "connected")?.name ?? "")

  const lspCount = createMemo(() => props.api.state.lsp().length)

  const graphLabel = () => {
    const s = staleness()
    if (!s) return "Graph: ..."
    if (s.isStale) return `Graph: ${s.reason ?? "stale"}`
    return `Graph: Fresh (${timeAgo(s.lastChecked)})`
  }

  const agentsLabel = () => `${agentCount()} agent${agentCount() !== 1 ? "s" : ""} active`
  const mcpLabel = () => (mcpConnectedCount() > 0 ? `MCP: ${mcpFirstConnected()}` : "MCP: —")
  const lspLabel = () => (lspCount() > 0 ? `LSP: ${lspCount()} server${lspCount() !== 1 ? "s" : ""}` : "LSP: Disabled")

  const dotColor = (ok: boolean) => (ok ? theme().success : theme().warning)

  return (
    <box flexDirection="row" gap={2}>
      <box flexDirection="row" gap={0}>
        <text fg={toHex(dotColor(agentCount() >= 0))}>●</text>
        <text fg={toHex(theme().textMuted)}> {agentsLabel()}</text>
      </box>
      <text fg={toHex(theme().textMuted)}>·</text>
      <box flexDirection="row" gap={0}>
        <text fg={toHex(dotColor(!staleness()?.isStale))}>●</text>
        <text fg={toHex(theme().textMuted)}> {graphLabel()}</text>
      </box>
      <text fg={toHex(theme().textMuted)}>·</text>
      <box flexDirection="row" gap={0}>
        <text fg={toHex(dotColor(mcpConnectedCount() > 0))}>●</text>
        <text fg={toHex(theme().textMuted)}> {mcpLabel()}</text>
      </box>
      <text fg={toHex(theme().textMuted)}>·</text>
      <box flexDirection="row" gap={0}>
        <text fg={toHex(dotColor(lspCount() > 0))}>●</text>
        <text fg={toHex(theme().textMuted)}> {lspLabel()}</text>
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
