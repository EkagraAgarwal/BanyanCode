/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, onCleanup, Show, For } from "solid-js"
import { useSync } from "../../context/sync"
import { toHex } from "../../util/color"
import { DialogAgentModel } from "../../component/dialog-agent-model"
import { useDialog } from "../../ui/dialog"

const id = "internal:inspector-agent-details"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function formatTokens(tokens: { input: number; output: number; reasoning: number } | undefined): string {
  if (!tokens) return "—"
  const total = tokens.input + tokens.output + tokens.reasoning
  return total.toLocaleString()
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "—"
  return money.format(cost)
}

function formatElapsed(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ago`
}

function StatusDot(props: { status: "active" | "idle" | "disconnected"; theme: () => any }) {
  const color = () => {
    const t = props.theme()
    if (props.status === "active") return toHex(t.success)
    if (props.status === "idle") return toHex(t.warning)
    if (props.status === "disconnected") return toHex(t.error)
    return toHex(t.textMuted)
  }
  const label = () => {
    if (props.status === "active") return "ACTIVE"
    if (props.status === "idle") return "IDLE"
    if (props.status === "disconnected") return "DISCONNECTED"
    return "OFFLINE"
  }
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={color()}>◉</text>
      <text fg={color()}>{label()}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const dialog = useDialog()

  const [tick, setTick] = createSignal(0)
  const timerRef: { current?: ReturnType<typeof setTimeout> } = {}
  timerRef.current = setTimeout(function scheduleTick() {
    setTick((t) => t + 1)
    timerRef.current = setTimeout(scheduleTick, 5000)
  }, 5000)
  onCleanup(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  })

  const session = createMemo(() => sync.session.get(props.sessionID))
  const sessionStatus = createMemo(() => sync.data.session_status[props.sessionID])

  const statusType = createMemo((): "active" | "idle" | "disconnected" => {
    const s = sessionStatus()
    if (!s) return "idle"
    if (s.type === "busy" || s.type === "retry") return "active"
    if (s.type === "idle") return "idle"
    return "idle"
  })

  const agentName = () => session()?.agent ?? "—"

  const task = createMemo(() => {
    const t = session()?.title
    if (!t) return "—"
    return t.length > 40 ? t.substring(0, 37) + "..." : t
  })

  const startMs = () => session()?.time.created ?? Date.now()
  const startedTime = createMemo(() => {
    void tick()
    return new Date(startMs()).toLocaleTimeString("en-US", { hour12: false })
  })

  const modelName = createMemo(() => {
    const m = session()?.model
    if (!m?.id) return "—"
    const parts = m.id.split("/")
    return parts[parts.length - 1]
  })

  const toolsUsed = createMemo(() => {
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
  })

  const toolsDisplay = createMemo(() => {
    const tools = toolsUsed()
    if (tools.length === 0) return "—"
    const first = tools.slice(0, 3).join(", ")
    const rest = tools.length > 3 ? ` +${tools.length - 3}` : ""
    return first + rest
  })

  const cost = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    return messages.reduce((sum: number, m: any) => sum + (m.cost ?? 0), 0)
  })

  const tokens = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const init = { input: 0, output: 0, reasoning: 0 }
    return messages.reduce((sum: typeof init, m: any) => {
      if (m.tokens) {
        sum.input += m.tokens.input ?? 0
        sum.output += m.tokens.output ?? 0
        sum.reasoning += m.tokens.reasoning ?? 0
      }
      return sum
    }, init)
  })

  const lastActivity = createMemo(() => {
    void tick()
    const messages = sync.data.message[props.sessionID] ?? []
    const lastAssistant = messages.findLast((m: any) => m.type === "assistant" || m.role === "assistant")
    if (!(lastAssistant as any)?.time?.completed) return null
    return formatElapsed((lastAssistant as any).time.completed)
  })

  const gridRow = (label: string, value: () => string) => (
    <box flexDirection="row" gap={1}>
      <text fg={toHex(theme().textMuted)}>{label}</text>
      <text fg={toHex(theme().text)}>{value()}</text>
    </box>
  )

  return (
    <box>
      <text fg={toHex(theme().primary)} marginBottom={1}>
        AGENT DETAILS
      </text>
      <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
        <text fg={toHex(theme().primary)}>
          <b>{agentName()}</b>
        </text>
        <StatusDot status={statusType()} theme={theme} />
      </box>
      {gridRow("Task:", task)}
      {gridRow("Started:", startedTime)}
      <box flexDirection="row" gap={1}>
        <text fg={toHex(theme().textMuted)}>Model:</text>
        <text
          fg={toHex(theme().info)}
          onMouseDown={() => dialog.replace(() => <DialogAgentModel agentName={agentName()} />)}
        >
          {modelName()} ▾
        </text>
      </box>
      {gridRow("Tools:", toolsDisplay)}
      {gridRow("Cost:", () => formatCost(cost()))}
      {gridRow("Tokens:", () => formatTokens(tokens()))}
      <Show when={lastActivity() !== null}>
        <box flexDirection="row" gap={1}>
          <text fg={toHex(theme().textMuted)}>Last:</text>
          <text fg={toHex(theme().text)}>{lastActivity()}</text>
        </box>
      </Show>
      <LspList api={props.api} />
    </box>
  )
}

interface LspEntry {
  id: string
  name: string
  root: string
  status: "configured" | "connected" | "error"
  autoDownload: boolean
}

function LspList(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.lsp() as unknown as LspEntry[])
  const lspEnabled = createMemo(() => {
    const cfg = (props.api.state as { banyanConfig?: { banyancode_lsp?: unknown } }).banyanConfig
    const v = cfg?.banyancode_lsp
    return v === true || (typeof v === "object" && v !== null)
  })

  return (
    <box flexDirection="column" marginTop={1} gap={0}>
      <text fg={toHex(theme().primary)} marginBottom={0}>
        <b>LSP</b>
      </text>
      <Show
        when={lspEnabled()}
        fallback={
          <text fg={toHex(theme().textMuted)}>
            Disabled. Run /lsp or set banyancode_lsp: true in banyancode.json.
          </text>
        }
      >
        <Show
          when={list().length > 0}
          fallback={<text fg={toHex(theme().textMuted)}>No LSP servers registered.</text>}
        >
          <For each={list()}>
            {(entry) => {
              const t = theme()
              const dot =
                entry.status === "connected"
                  ? toHex(t.success)
                  : entry.status === "error"
                    ? toHex(t.error)
                    : toHex(t.textMuted)
              const label =
                entry.status === "connected" ? "on" : entry.status === "error" ? "err" : "idle"
              return (
                <box flexDirection="row" gap={1}>
                  <text fg={dot}>●</text>
                  <text fg={toHex(t.text)}>{entry.name}</text>
                  <text fg={dot}>[{label}]</text>
                  <Show when={entry.autoDownload}>
                    <text fg={toHex(t.info)}>↓ auto</text>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
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
