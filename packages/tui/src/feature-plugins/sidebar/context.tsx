/** @jsxImportSource @opentui/solid */
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { toHex } from "../../util/color"
import { RoundedBorder } from "../../ui/border"

const id = "internal:sidebar-context"

const FILES_TOOLS = new Set([
  "read",
  "read_file",
  "read-filesystem",
  "glob",
  "grep",
  "ls",
  "list",
  "edit",
  "write",
  "write_file",
  "apply-patch",
  "code-find",
  "code_find",
  "structural-queries",
])
const SUBAGENT_TOOLS = new Set([
  "mesh_control",
  "mesh-control",
  "mesh_subscribe",
  "mesh-subscribe",
  "subagent_message",
  "subagent-message",
  "plan",
  "task",
])
const TOKEN_HEURISTIC_CHARS_PER_TOKEN = 4

const estimateTokens = (s: string): number =>
  s.length === 0 ? 0 : Math.max(1, Math.ceil(s.length / TOKEN_HEURISTIC_CHARS_PER_TOKEN))

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

const sumToolTokens = (tool: any): number => {
  let total = 0
  const s = tool?.state ?? tool
  if (!s) return 0
  if (s.status === "pending") {
    total += estimateTokens(String(s.input ?? ""))
    return total
  }
  if (s.input) {
    total += estimateTokens(typeof s.input === "string" ? s.input : JSON.stringify(s.input))
  }
  if (s.output && typeof s.output === "string") {
    total += estimateTokens(s.output)
  }
  if (Array.isArray(s.content)) {
    for (const item of s.content) {
      if (typeof item === "string") total += estimateTokens(item)
      else if (typeof item?.text === "string") total += estimateTokens(item.text)
      else if (typeof item?.value === "string") total += estimateTokens(item.value)
    }
  }
  if (Array.isArray(s.attachments)) {
    for (const att of s.attachments) {
      if (typeof att?.text === "string") total += estimateTokens(att.text)
      else if (typeof att?.value === "string") total += estimateTokens(att.value)
    }
  }
  if (typeof s.error === "string") {
    total += estimateTokens(s.error)
  } else if (s.error && typeof s.error === "object") {
    total += estimateTokens(JSON.stringify(s.error))
  }
  if (s.result) {
    total += estimateTokens(typeof s.result === "string" ? s.result : JSON.stringify(s.result))
  }
  return total
}

const categorizeTokens = (messages: ReadonlyArray<Message>) => {
  let filesTokens = 0
  let toolsTokens = 0
  let subagentTokens = 0
  let userTokens = 0
  let reasoning = 0
  let output = 0
  let lastAssistant: AssistantMessage | undefined

  for (const m of messages) {
    const role = (m as any).role ?? (m as any).type
    if (role === "user") {
      const u = m as any
      let text = ""
      if (typeof u.text === "string") text = u.text
      else if (typeof u.prompt === "string") text = u.prompt
      else if (Array.isArray(u.content)) {
        text = u.content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join(" ")
      } else if (Array.isArray(u.parts)) {
        text = u.parts.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join(" ")
      }
      if (text) userTokens += estimateTokens(text)
      continue
    }
    if (role !== "assistant") continue
    const a = m as AssistantMessage
    lastAssistant = a
    const parts = (a as any).content ?? (a as any).parts ?? []
    for (const part of parts) {
      if (part?.type !== "tool") continue
      const t = part as any
      const toolName = t.name ?? t.tool ?? ""
      const est = sumToolTokens(t)
      if (SUBAGENT_TOOLS.has(toolName)) subagentTokens += est
      else if (FILES_TOOLS.has(toolName)) filesTokens += est
      else if (toolName) toolsTokens += est
    }
    reasoning += a.tokens?.reasoning ?? 0
    output += a.tokens?.output ?? 0
  }

  if (!lastAssistant) return null

  const tokens = lastAssistant.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const inputTotal = tokens.input ?? 0
  const prompt = Math.max(0, inputTotal - filesTokens - toolsTokens - subagentTokens - userTokens)
  return {
    thinking: reasoning,
    files: filesTokens,
    tools: toolsTokens,
    output,
    prompt,
    userMessages: userTokens,
    subagents: subagentTokens,
    total: inputTotal + output + reasoning,
  }
}

interface Segment {
  key: string
  label: string
  tokens: number
  color: "primary" | "accent" | "info" | "success" | "warning" | "muted"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  const messages = createMemo(() => props.api.state.session.messages(props.session_id))

  const lastAssistant = createMemo(() => {
    return messages().findLast(
      (item): item is AssistantMessage =>
        ((item as any).role === "assistant" || (item as any).type === "assistant") &&
        "tokens" in item &&
        !!(item as any).tokens &&
        (((item as any).tokens.output ?? 0) > 0 || ((item as any).tokens.input ?? 0) > 0),
    )
  })

  const categorization = createMemo(() => categorizeTokens(messages()))

  const modelContextLimit = createMemo(() => {
    const last = lastAssistant()
    if (!last) return null
    const provider = props.api.state.provider.find((p) => p.id === last.providerID)
    return provider?.models[last.modelID]?.limit?.context ?? null
  })

  const contextPercent = createMemo(() => {
    const tb = categorization()
    const limit = modelContextLimit()
    if (!tb || !limit || limit === 0) return null
    return Math.round((tb.total / limit) * 100)
  })

  const segments = createMemo<Segment[]>(() => {
    const cat = categorization()
    if (!cat) return []
    return [
      { key: "user", label: "User", tokens: cat.userMessages, color: "muted" },
      { key: "thinking", label: "Thinking", tokens: cat.thinking, color: "accent" },
      { key: "prompt", label: "Prompt", tokens: cat.prompt, color: "info" },
      { key: "files", label: "Files", tokens: cat.files, color: "success" },
      { key: "tools", label: "Tools", tokens: cat.tools, color: "warning" },
      { key: "subagents", label: "Subagents", tokens: cat.subagents, color: "muted" },
      { key: "output", label: "Agent", tokens: cat.output, color: "primary" },
    ]
  })

  const segColor = (color: Segment["color"]): string => {
    const t = theme()
    if (color === "primary") return toHex(t.primary)
    if (color === "accent") return toHex(t.accent)
    if (color === "info") return toHex(t.info)
    if (color === "success") return toHex(t.success)
    if (color === "warning") return toHex(t.warning)
    if (color === "muted") return toHex(t.textMuted)
    return toHex(t.text)
  }

  const BAR_WIDTH = 24

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={toHex(theme().primary)}>
          <b>CONTEXT</b>
        </text>
        <Show when={categorization()}>
          {(tb) => {
            const limit = modelContextLimit() ?? 1
            return (
              <text fg={toHex(theme().textMuted)}>
                {" "}{formatTokensCompact(tb().total)} / {formatTokensCompact(limit)} ({contextPercent() ?? 0}%)
              </text>
            )
          }}
        </Show>
      </box>
      <Show when={categorization()}>
        {(tb) => {
          const limit = modelContextLimit() ?? 1
          const usedWidthTotal = () =>
            segments()
              .filter((s) => s.tokens > 0)
              .reduce((sum, seg) => sum + Math.max(0, Math.round((seg.tokens / limit) * BAR_WIDTH)), 0)
          return (
            <box flexDirection="column" gap={0}>
              <box
                width={BAR_WIDTH + 2}
                height={3}
                marginTop={0}
                customBorderChars={RoundedBorder.customBorderChars}
                border={["left", "right", "top", "bottom"]}
                borderColor={theme().borderSubtle}
                flexDirection="row"
              >
                <Show when={tb().total > 0}>
                  <For each={segments().filter((s) => s.tokens > 0)}>
                    {(seg) => (
                      <box
                        width={Math.max(0, Math.round((seg.tokens / limit) * BAR_WIDTH))}
                        backgroundColor={segColor(seg.color)}
                        height={1}
                      />
                    )}
                  </For>
                </Show>
                <box
                  width={Math.max(0, BAR_WIDTH - usedWidthTotal())}
                  backgroundColor={toHex(theme().backgroundElement)}
                  height={1}
                />
              </box>
              <box flexDirection="row" marginTop={0} width="100%">
                <text>
                  <span style={{ fg: toHex(theme().text) }}>Used {formatTokensCompact(tb().total)} </span>
                  <span style={{ fg: toHex(theme().textMuted) }}>/ {formatTokensCompact(limit)} in context</span>
                </text>
              </box>
              <box flexDirection="column" marginTop={0} gap={0} width="100%">
                <For each={segments().filter((s) => s.tokens > 0)}>
                  {(seg) => {
                    const pct = () => {
                      if (tb().total === 0) return "0.0"
                      return ((seg.tokens / tb().total) * 100).toFixed(1)
                    }
                    return (
                      <box flexDirection="row" justifyContent="space-between" width="100%">
                        <box flexDirection="row" gap={1}>
                          <text fg={segColor(seg.color)}>■</text>
                          <text fg={toHex(theme().text)}>{seg.label}</text>
                        </box>
                        <box flexDirection="row" gap={1}>
                          <text fg={toHex(theme().text)}>
                            {formatTokensCompact(seg.tokens)}
                          </text>
                          <text fg={toHex(theme().textMuted)}>
                            {`${pct()}%`}
                          </text>
                        </box>
                      </box>
                    )
                  }}
                </For>
              </box>
            </box>
          )
        }}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

