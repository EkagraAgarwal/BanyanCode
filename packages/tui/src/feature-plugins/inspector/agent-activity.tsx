/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"

const id = "internal:inspector-agent-activity"

interface Peer {
  sessionID: string
  agent: string
  status: "active" | "idle" | "disconnected"
  lastSeenAt: number
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  lastActivityAt?: number
  blockedReason?: string
}

interface MeshStatus {
  parentSessionID: string
  peers: Peer[]
  pendingMessages: number
  recentActivity: Array<{ from: string; at: number }>
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function peerTokensTotal(p: Peer): number {
  if (!p.tokens) return 0
  return p.tokens.input + p.tokens.output + p.tokens.reasoning + p.tokens.cache.read + p.tokens.cache.write
}

function statusColor(status: Peer["status"], theme: () => any): string {
  const t = theme()
  if (status === "active") return toHex(t.success)
  if (status === "idle") return toHex(t.warning)
  if (status === "disconnected") return toHex(t.error)
  return toHex(t.textMuted)
}

function PeerRow(props: { peer: Peer; theme: () => any }) {
  const p = props.peer
  const stateLabel = p.status === "active" ? "active" : p.status === "idle" ? "idle" : p.status === "disconnected" ? "disconnected" : "offline"
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={statusColor(p.status, props.theme)}>◉</text>
      <text fg={toHex(props.theme().text)}><b>{p.agent}</b></text>
      <text fg={statusColor(p.status, props.theme)}>·</text>
      <text fg={statusColor(p.status, props.theme)}>{stateLabel}</text>
      <Show when={p.cost !== undefined}>
        <text fg={toHex(props.theme().textMuted)}>·</text>
        <text fg={toHex(props.theme().textMuted)}>{money.format(p.cost!)}</text>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()

  const [meshStatus, setMeshStatus] = createSignal<MeshStatus | null>(null)
  const [eventFired, setEventFired] = createSignal(false)

  const unsub = ev.on("banyancode.mesh.status" as any, (event: any) => {
    setEventFired(true)
    setMeshStatus(event.properties as MeshStatus)
  })
  onCleanup(unsub)

  const peers = createMemo(() => meshStatus()?.peers ?? [])
  const peerCount = createMemo(() => peers().length)

  return (
    <box>
      <text fg={toHex(theme().primary)} marginBottom={1}>
        AGENT ACTIVITY {peerCount()}
      </text>
      <Show
        when={peers().length > 0}
        fallback={
          <text fg={toHex(theme().textMuted)}>No active agents</text>
        }
      >
        <box flexDirection="column" gap={0}>
          <For each={peers()}>{(peer) => <PeerRow peer={peer} theme={theme} />}</For>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      session_inspector() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
