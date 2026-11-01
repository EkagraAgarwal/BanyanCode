import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { formatMoney, formatTokens } from "../../data/format"
import type { MeshLive } from "../../data/live"
import { meshPeers, type PeerRow } from "../../data/mesh"
import { palette, type Palette } from "../../theme"

function statusColor(peer: PeerRow, theme: Palette) {
  if (peer.status === "active") return theme.success
  if (peer.status === "idle") return theme.warning
  return theme.error
}

function stateLabel(status: PeerRow["status"]): string {
  if (status === "active") return "active"
  if (status === "idle") return "idle"
  return "disconnected"
}

function PeerLine(props: { readonly context: Context; readonly peer: PeerRow }) {
  const theme = () => palette(props.context.theme)
  const [hover, setHover] = createSignal(false)
  return (
    <box
      flexDirection="row"
      gap={1}
      alignItems="center"
      width="100%"
      backgroundColor={hover() ? theme().surfaceHigh : undefined}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseDown={() =>
        props.context.ui.router.navigate({ type: "session", sessionID: props.peer.sessionID })
      }
    >
      <text fg={statusColor(props.peer, theme())}>◉</text>
      <text fg={theme().text}>
        <b>{props.peer.agent}</b>
      </text>
      <text fg={statusColor(props.peer, theme())}>[{stateLabel(props.peer.status)}]</text>
      <Show when={props.peer.cost !== undefined}>
        <text fg={theme().muted}>{formatMoney(props.peer.cost ?? 0)}</text>
      </Show>
      <Show when={props.peer.tokens !== undefined}>
        <text fg={theme().muted}>{formatTokens(props.peer.tokens ?? 0)} tok</text>
      </Show>
    </box>
  )
}

/**
 * Ported from v1 `sidebar/agents.tsx`. Peer rows come from the mesh RPC tree;
 * when the mesh namespace is not registered the panel states that instead of
 * rendering a bogus empty mesh.
 */
export function AgentsPanel(props: {
  readonly context: Context
  readonly sessionID: string
  readonly mesh: MeshLive
  readonly fallbackMax?: number
}) {
  const theme = () => palette(props.context.theme)
  const root = createMemo(() => props.context.data.session.root(props.sessionID))

  onMount(() => {
    void props.mesh.ensure(root())
    void props.mesh.refreshLimits()
  })

  const peers = createMemo(() => meshPeers(props.mesh.root(root())))
  const active = createMemo(() => peers().filter((peer) => peer.status === "active").length)
  const max = createMemo(() => props.mesh.limits()?.maxSubagents ?? props.fallbackMax ?? 5)

  // Visibility rule (v1): any active peer wins; otherwise the 5 most recent
  // idle/disconnected peers, so the sidebar never lists 20 stale rows.
  const visible = createMemo(() => {
    const all = peers()
    const running = all.filter((peer) => peer.status === "active")
    if (running.length > 0) return running
    return [...all].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, 5)
  })

  return (
    <box>
      <text fg={theme().primary}>
        AGENTS {active()}/{max()} active
      </text>
      <Show
        when={props.mesh.availability() !== "unavailable"}
        fallback={<text fg={theme().muted}>Mesh status is not available on this server.</text>}
      >
        <Show
          when={visible().length > 0}
          fallback={<text fg={theme().muted}>No active agents</text>}
        >
          <box flexDirection="column" gap={0}>
            <For each={visible()}>{(peer) => <PeerLine context={props.context} peer={peer} />}</For>
          </box>
        </Show>
      </Show>
    </box>
  )
}
