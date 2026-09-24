/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import type { Session } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { useData } from "../../context/data"
import { toHex } from "../../util/color"

export * as HeaderSessionCost from "./session-cost"

const id = "internal:header-session-cost"

// WS7b (specs/banyancode/prompt-caching-optimization-plan.md): cache billing
// multipliers relative to the model's input price — reads bill at 0.1x, writes
// at 1.25x. Cached input is still billed; "$saved" is the avoided cost vs
// paying full input price for the same tokens, not free tokens.
const CACHE_READ_MULT = 0.1
const CACHE_WRITE_MULT = 1.25

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

export type CacheSession = Pick<Session, "tokens"> & {
  model?: { id: string; providerID?: string }
}

/**
 * Aggregate cache hit rate (and optional $saved) across a session + children.
 *
 * TUI-facing fields (from `session.ts getUsage` / `publish-llm-event tokens()`):
 * `tokens.input` is NON-cached input (`inputTokens - cacheRead - cacheWrite`),
 * `tokens.cache.read` is cached input hits, `tokens.cache.write` is cache
 * writes. Usage invariant: nonCached + cacheRead + cacheWrite = inputTokens,
 * so the hit-rate denominator is total input including writes (writes are
 * misses). Returns undefined when the sessions carry no cache tokens.
 */
export function cacheSummary(
  sessions: readonly CacheSession[],
  inputPricePerMillion: (model: { id: string; providerID?: string }) => number | undefined,
): { hitPercent: number; saved?: number } | undefined {
  let uncached = 0
  let read = 0
  let write = 0
  let saved = 0
  let priced = false
  for (const session of sessions) {
    const tokens = session.tokens
    if (!tokens) continue
    uncached += tokens.input
    read += tokens.cache.read
    write += tokens.cache.write
    if (!session.model || tokens.cache.read + tokens.cache.write === 0) continue
    const price = inputPricePerMillion(session.model)
    if (price === undefined) continue
    priced = true
    saved += (((1 - CACHE_READ_MULT) * tokens.cache.read - (CACHE_WRITE_MULT - 1) * tokens.cache.write) * price) / 1_000_000
  }
  if (read + write === 0) return undefined
  const total = uncached + read + write
  return {
    hitPercent: Math.round((read / total) * 100),
    ...(priced && saved >= 0.005 ? { saved } : {}),
  }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const sync = useSync()
  const ev = useEvent()
  const data = useData()

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

  const summary = () => {
    const s = session()
    if (!s?.tokens) return undefined
    return cacheSummary([s, ...children()], (model) => {
      const info = data.location.model
        .list()
        ?.find((item) => item.id === model.id && item.providerID === model.providerID)
      const base = info?.cost?.find((entry) => entry.tier === undefined) ?? info?.cost?.[0]
      return base?.input
    })
  }

  const hasChildren = () => children().length > 0

  const hasData = () => cost() !== undefined && tokens() !== undefined

  const label = () => {
    const base = `Session: $${cost()!.toFixed(2)} · ${formatTokens(tokens()!)} tok ${hasChildren() ? "(incl. subagents)" : "(session total)"}`
    const stats = summary()
    if (!stats) return base
    const withCache = `${base} · cached ${stats.hitPercent}%`
    return stats.saved === undefined ? withCache : `${withCache} · saved $${stats.saved.toFixed(2)}`
  }

  return (
    <Show when={hasData()}>
      <text fg={toHex(theme().text)}>{label()}</text>
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
