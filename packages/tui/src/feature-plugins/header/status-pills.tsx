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

  const ev = useEvent()
  const unsubSession = ev.on("session.updated" as any, () => refreshSessionCount())
  onCleanup(unsubSession)

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

  const lspCount = createMemo(() => props.api.state.lsp().length)

  const agentsLabel = () => `${activeSessionCount()} active`
  const mcpLabel = () => (mcpConnectedCount() > 0 ? `MCP: ${mcpFirstConnected()}` : "MCP: —")
  const lspLabel = () => (lspCount() > 0 ? `LSP: ${lspCount()}` : "LSP: off")

  const agentsSeverity = (): Severity => (activeSessionCount() > 0 ? "success" : "neutral")
  const mcpSeverity = (): Severity => (mcpConnectedCount() > 0 ? "success" : "error")
  const lspSeverity = (): Severity => (lspCount() > 0 ? "success" : "error")

  const agentsDotColor = () => (activeSessionCount() > 0 ? toHex(theme().success) : toHex(theme().textMuted))
  const mcpDotColor = () => (mcpConnectedCount() > 0 ? toHex(theme().success) : toHex(theme().error))
  const lspDotColor = () => (lspCount() > 0 ? toHex(theme().success) : toHex(theme().error))

  const agentsBorderColor = () => (activeSessionCount() > 0 ? theme().success : theme().textMuted)
  const mcpBorderColor = () => (mcpConnectedCount() > 0 ? theme().success : theme().error)
  const lspBorderColor = () => (lspCount() > 0 ? theme().success : theme().error)

  const accentForSeverity = (severity: Severity) =>
    severity === "success"
      ? theme().success
      : severity === "warning"
        ? theme().warning
        : severity === "error"
          ? theme().error
          : severity === "info"
            ? theme().info
            : theme().borderSubtle

  const agentsPillBg = () => pillFill(theme().backgroundPanel, accentForSeverity(agentsSeverity()), agentsSeverity())
  const mcpPillBg = () => pillFill(theme().backgroundPanel, accentForSeverity(mcpSeverity()), mcpSeverity())
  const lspPillBg = () => pillFill(theme().backgroundPanel, accentForSeverity(lspSeverity()), lspSeverity())

  return (
    <box flexDirection="row" gap={2} alignItems="center">
      <box
        flexDirection="row"
        flexShrink={0}
        customBorderChars={RoundedBorder.customBorderChars}
        border={["left", "right", "top", "bottom"]}
        borderColor={agentsBorderColor()}
        backgroundColor={agentsPillBg()}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={agentsDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{" "}{agentsLabel()}</text>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        customBorderChars={RoundedBorder.customBorderChars}
        border={["left", "right", "top", "bottom"]}
        borderColor={mcpBorderColor()}
        backgroundColor={mcpPillBg()}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={mcpDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{" "}{mcpLabel()}</text>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        customBorderChars={RoundedBorder.customBorderChars}
        border={["left", "right", "top", "bottom"]}
        borderColor={lspBorderColor()}
        backgroundColor={lspPillBg()}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={lspDotColor()}>●</text>
        <text fg={toHex(theme().textMuted)}>{" "}{lspLabel()}</text>
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
