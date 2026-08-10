/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import type { Session } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { toHex } from "../../util/color"

export * as HeaderSessionCost from "./session-cost"

const id = "internal:header-session-cost"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function totalTokens(session: { tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }): number {
  const t = session.tokens
  if (!t) return 0
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const sync = useSync()
  const ev = useEvent()

  const [tick, setTick] = createSignal(0)
  const [children, setChildren] = createSignal<Session[]>([])

  // Children publish their own `session.updated` events, so refetch them on
  // every update tick (parent or child) and once on mount.
  const refreshChildren = async () => {
    try {
      const res = await props.api.client.session.children({ sessionID: props.session_id })
      setChildren(res.data ?? [])
    } catch {
      setChildren([])
    }
  }

  const unsub = ev.on("session.updated" as any, () => {
    setTick((t) => t + 1)
    void refreshChildren()
  })
  onCleanup(unsub)

  onMount(() => {
    void refreshChildren()
  })

  const session = () => {
    void tick()
    return sync.session.get(props.session_id)
  }

  const cost = () => {
    const s = session()
    if (s?.cost === undefined) return undefined
    let total = s.cost
    for (const child of children()) total += child.cost ?? 0
    return total
  }

  const tokens = () => {
    const s = session()
    if (!s?.tokens) return undefined
    let total = totalTokens(s)
    for (const child of children()) total += totalTokens(child)
    return total
  }

  const hasChildren = () => children().length > 0

  const hasData = () => cost() !== undefined && tokens() !== undefined

  return (
    <Show when={hasData()}>
      <text fg={toHex(theme().text)}>
        Session: ${cost()!.toFixed(2)} · {formatTokens(tokens()!)} tok {hasChildren() ? "(incl. subagents)" : "(session total)"}
      </text>
    </Show>
  )
}

const plugin: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      app_top(_ctx, props) {
        const p = props as { session_id: string }
        return <View api={api} session_id={p.session_id} />
      },
    },
  })
}

export default { id, tui: plugin } satisfies BuiltinTuiPlugin
