/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup, Show } from "solid-js"
import { useSync } from "../../context/sync"

const id = "internal:inspector-agent-details"

function toHex(color: { r: number; g: number; b: number; a?: number } | string): string {
  if (typeof color === "string") return color
  const toComponent = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v))
  const a = color.a !== undefined ? toComponent(color.a).toString(16).padStart(2, "0") : ""
  return `#${toComponent(color.r).toString(16).padStart(2, "0")}${toComponent(color.g).toString(16).padStart(2, "0")}${toComponent(color.b).toString(16).padStart(2, "0")}${a}`
}

function formatTokens(tokens: { input: number; output: number; reasoning: number } | undefined): string {
  if (!tokens) return "—"
  return (tokens.input + tokens.output + tokens.reasoning).toLocaleString()
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "—"
  return `$${cost.toFixed(4)}`
}

function formatElapsed(startMs: number): string {
  const secs = Math.floor((Date.now() - startMs) / 1000)
  return `${secs}s`
}

function StatusDot(props: { status: "running" | "idle" | "completed"; theme: any }) {
  const colors = {
    running: toHex(props.theme.success),
    idle: toHex(props.theme.warning),
    completed: toHex(props.theme.textMuted),
  }
  return <text fg={colors[props.status]}>{props.status === "running" ? "●" : "○"}</text>
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current

  const [tick, setTick] = createSignal(0)

  // Re-render every second while a session is running so the timer updates.
  const timerRef: { current?: ReturnType<typeof setTimeout> } = {}
  timerRef.current = setTimeout(function scheduleTick() {
    setTick((t) => t + 1)
    timerRef.current = setTimeout(scheduleTick, 1000)
  }, 1000)

  onCleanup(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  })

  const session = () => sync.session.get(props.sessionID)

  const statusType = () => {
    const s = sync.data.session_status[props.sessionID]
    if (!s) return "idle"
    if (s.type === "idle") return "idle"
    if (s.type === "busy" || s.type === "retry") return "running"
    return "idle"
  }

  const agentName = () => session()?.agent ?? "—"

  const toolsUsed = () => {
    const messages = sync.data.message[props.sessionID] ?? []
    const toolNames = new Set<string>()
    for (const msg of messages) {
      const parts = sync.data.part[msg.id] ?? []
      for (const part of parts) {
        if (part.type === "tool" && part.tool) {
          toolNames.add(part.tool)
        }
      }
    }
    return Array.from(toolNames)
  }

  const lastMessage = () => {
    const messages = sync.data.message[props.sessionID] ?? []
    const lastAssistant = messages.findLast((m) => m.role === "assistant")
    if (!lastAssistant) return "—"
    const parts = sync.data.part[lastAssistant.id] ?? []
    const textParts = parts.filter((part) => part.type === "text")
    const text = textParts.map((part) => part.text).join(" ").trim()
    if (!text) return "—"
    if (text.length > 40) {
      return text.substring(0, 37) + "..."
    }
    return text
  }

  const tokens = () => session()?.tokens
  const cost = () => session()?.cost

  const startMs = () => session()?.time.updated ?? Date.now()

  // Force tick access to subscribe to timer updates.
  void tick()

  const elapsed = () => formatElapsed(startMs())

  return (
    <box>
      <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
        <text fg={toHex(theme().text)}>
          <b>{agentName()}</b>
        </text>
        <box flexDirection="row" gap={1}>
          <StatusDot status={statusType() as "running" | "idle" | "completed"} theme={theme()} />
          <text fg={toHex(theme().primary)}>{statusType().toUpperCase()}</text>
          <Show when={statusType() === "running"}>
            <text fg={toHex(theme().textMuted)}>({elapsed()})</text>
          </Show>
        </box>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={toHex(theme().textMuted)}>Tools  </text>
        <text fg={toHex(theme().text)}>{toolsUsed().length > 0 ? toolsUsed().join(", ") : "None"}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={toHex(theme().textMuted)}>Tokens </text>
        <text fg={toHex(theme().text)}>{formatTokens(tokens())}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={toHex(theme().textMuted)}>Cost   </text>
        <text fg={toHex(theme().text)}>{formatCost(cost())}</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={toHex(theme().textMuted)}>LastMsg</text>
        <text fg={toHex(theme().text)}>{lastMessage()}</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      session_inspector(_ctx, slotProps) {
        const sessionID = (slotProps as { session_id?: string }).session_id
        if (!sessionID) return () => <box />
        return <View api={api} sessionID={sessionID} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin