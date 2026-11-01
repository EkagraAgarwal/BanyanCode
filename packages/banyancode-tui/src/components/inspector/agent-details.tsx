import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { formatMoney, formatTokens } from "../../data/format"
import { lastAssistant, toolNames, totalTokens } from "../../data/messages"
import { palette } from "../../theme"

function ago(ms: number | undefined, now: number): string {
  if (ms === undefined) return "—"
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

/** Ported from v1 `inspector/agent-details.tsx`. */
export function AgentDetails(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const [now, setNow] = createSignal(Date.now())

  const timer = setInterval(() => setNow(Date.now()), 5_000)
  onCleanup(() => clearInterval(timer))

  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const status = createMemo(() => props.context.data.session.status(props.sessionID))
  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const tokens = createMemo(() => totalTokens(session()?.tokens))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  onMount(() => {
    void props.context.data.session.message.sync(props.sessionID)
  })

  const modelName = createMemo(() => {
    const model = session()?.model
    if (!model?.id) return "—"
    return model.id.split("/").at(-1) ?? model.id
  })

  const tools = createMemo(() => toolNames(messages()))
  const toolsLabel = createMemo(() => {
    const names = tools()
    if (names.length === 0) return "—"
    const head = names.slice(0, 3).join(", ")
    return names.length > 3 ? `${head} +${names.length - 3}` : head
  })

  const lastActivity = createMemo(() => lastAssistant(messages(), true)?.time.completed)

  return (
    <box>
      <text fg={theme().primary} marginBottom={1}>
        AGENT DETAILS
      </text>
      <box flexDirection="row" gap={1} justifyContent="space-between" width="100%">
        <text fg={theme().primary}>
          <b>{session()?.agent ?? "—"}</b>
        </text>
        <text fg={status() === "running" ? theme().success : theme().muted}>
          {status() === "running" ? "ACTIVE" : "IDLE"}
        </text>
      </box>
      <text fg={theme().text}>Task: {session()?.title ?? "—"}</text>
      <text fg={theme().text}>
        Started:{" "}
        {session()?.time.created
          ? new Date(session()!.time.created).toLocaleTimeString("en-US", { hour12: false })
          : "—"}
      </text>
      <text fg={theme().info}>Model: {modelName()}</text>
      <text fg={theme().text}>Tools: {toolsLabel()}</text>
      <text fg={theme().text}>Cost: {formatMoney(cost())}</text>
      <text fg={theme().text}>Tokens: {formatTokens(tokens())}</text>
      <Show when={lastActivity() !== undefined}>
        <text fg={theme().text}>Last: {ago(lastActivity(), now())}</text>
      </Show>
      <Show when={session()?.outcome !== undefined}>
        <text fg={theme().muted}>Outcome: {session()!.outcome}</text>
      </Show>
    </box>
  )
}
