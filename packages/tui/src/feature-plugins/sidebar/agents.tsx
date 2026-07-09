/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"
import { DashedDividerChars } from "../../ui/border"

const id = "internal:sidebar-agents"

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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function peerTokensTotal(p: Peer): number {
  if (!p.tokens) return 0
  return p.tokens.input + p.tokens.output + p.tokens.reasoning + p.tokens.cache.read + p.tokens.cache.write
}

function statusColor(status: Peer["status"], theme: any): string {
  if (status === "active") return toHex(theme.success)
  if (status === "idle") return toHex(theme.warning)
  if (status === "disconnected") return toHex(theme.error)
  return toHex(theme.textMuted)
}

function PeerRow(props: { peer: Peer; theme: any }) {
  const p = props.peer
  const stateLabel = p.status === "active" ? "active" : p.status === "idle" ? "idle" : p.status === "disconnected" ? "disconnected" : "offline"
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <text fg={statusColor(p.status, props.theme)}>◉</text>
      <text fg={toHex(props.theme.text)}><b>{p.agent}</b></text>
      <text fg={statusColor(p.status, props.theme)}>[{stateLabel}]</text>
      <Show when={p.cost !== undefined}>
        <text fg={toHex(props.theme.textMuted)}>{money.format(p.cost!)}</text>
      </Show>
      <Show when={p.tokens}>
        <text fg={toHex(props.theme.textMuted)}>{formatTokens(peerTokensTotal(p))} tok</text>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const ev = useEvent()

  const [meshStatus, setMeshStatus] = createSignal<MeshStatus | null>(null)
  const [maxSubagents, setMaxSubagents] = createSignal(5)
  const [pollTimer, setPollTimer] = createSignal<ReturnType<typeof setTimeout> | null>(null)
  const [eventFired, setEventFired] = createSignal(false)

  const loadConfig = async () => {
    try {
      const result = await props.api.client.global.banyanConfig.get({})
      if (result?.data) {
        setMaxSubagents(Number(result.data.banyancode_max_subagents) || 5)
      }
    } catch {}
  }
  void loadConfig()

  const fetchMesh = async () => {
    try {
      const result = await props.api.client.session.mesh({ sessionID: props.session_id })
      if (result?.data) {
        setMeshStatus(result.data as MeshStatus)
      }
    } catch {}
  }

  const unsub = ev.on("banyancode.mesh.status" as any, (event: any) => {
    setEventFired(true)
    setMeshStatus(event.properties as MeshStatus)
    if (pollTimer()) {
      clearTimeout(pollTimer()!)
      setPollTimer(null)
    }
  })
  onCleanup(unsub)

  if (!eventFired()) {
    void fetchMesh()
    const timer = setTimeout(() => {
      setEventFired(true)
      setPollTimer(null)
    }, 5000)
    setPollTimer(timer)
    onCleanup(() => {
      if (pollTimer()) clearTimeout(pollTimer()!)
    })
  }

  const peers = createMemo(() => meshStatus()?.peers ?? [])
  const activeCount = createMemo(() => peers().filter((p) => p.status === "active").length)

  const totalCost = createMemo(() => peers().reduce((sum, p) => sum + (p.cost ?? 0), 0))
  const totalTokens = createMemo(() => peers().reduce((sum, p) => sum + peerTokensTotal(p), 0))

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        AGENTS {activeCount()}/{maxSubagents()} active
      </text>
      <Show
        when={peers().length > 0}
        fallback={
          <text fg={toHex(theme().textMuted)} marginTop={1}>
            No active agents
          </text>
        }
      >
        <box flexDirection="column" marginTop={1} gap={0}>
          <For each={peers()}>{(peer) => <PeerRow peer={peer} theme={theme()} />}</For>
        </box>
        <text fg={toHex(theme().borderSubtle)} marginTop={1}>
          {DashedDividerChars.horizontal.repeat(80)}
        </text>
        <box flexDirection="row" gap={1} marginTop={0}>
          <text fg={toHex(theme().textMuted)}>Total across all agents</text>
          <text fg={toHex(theme().text)}>{money.format(totalCost())}</text>
          <text fg={toHex(theme().textMuted)}>·</text>
          <text fg={toHex(theme().text)}>{formatTokens(totalTokens())} tok</text>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 60,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }
export default plugin
