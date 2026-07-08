/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup, Show } from "solid-js"
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

  const unsub = ev.on("session.updated" as any, () => setTick((t) => t + 1))
  onCleanup(unsub)

  const session = () => {
    void tick()
    return sync.session.get(props.session_id)
  }

  const cost = () => session()?.cost
  const tokens = () => {
    const s = session()
    if (!s?.tokens) return undefined
    return totalTokens(s)
  }

  const hasData = () => cost() !== undefined && tokens() !== undefined

  return (
    <Show when={hasData()}>
      <text fg={toHex(theme().text)}>
        Session: ${cost()!.toFixed(2)} · {formatTokens(tokens()!)} tok
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
