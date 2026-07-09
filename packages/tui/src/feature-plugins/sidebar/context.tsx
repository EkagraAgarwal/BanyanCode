/** @jsxImportSource @opentui/solid */
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { toHex } from "../../util/color"

const id = "internal:sidebar-context"

const FILES_TOOLS = new Set(["read", "glob", "grep", "ls", "list"])
const TOKEN_HEURISTIC_CHARS_PER_TOKEN = 4

const estimateTokens = (s: string): number =>
  s.length === 0 ? 0 : Math.max(1, Math.ceil(s.length / TOKEN_HEURISTIC_CHARS_PER_TOKEN))

interface ToolPart {
  type: "tool"
  tool: string
  state: {
    status: string
    input?: unknown
    output?: string
    content?: Array<{ type: string; text?: string }>
    attachments?: Array<{ text?: string }>
    error?: string
    [key: string]: unknown
  }
}

const sumToolTokens = (tool: ToolPart): number => {
  let total = 0
  const s = tool.state
  if (s.status === "pending") {
    total += estimateTokens(String(s.input ?? ""))
    return total
  }
  if (s.input && typeof s.input === "object") {
    total += estimateTokens(JSON.stringify(s.input))
  }
  if (Array.isArray(s.content)) {
    for (const item of s.content) {
      if (typeof item?.text === "string") total += estimateTokens(item.text)
    }
  }
  if (Array.isArray(s.attachments)) {
    for (const att of s.attachments) {
      if (typeof att?.text === "string") total += estimateTokens(att.text)
    }
  }
  if (typeof s.error === "string") {
    total += estimateTokens(s.error)
  }
  return total
}

const categorizeTokens = (assistant: AssistantMessage) => {
  // Heuristic attribution: tool-name → category, text-length/4 token
  // estimate. Not exact — the AI SDK reports only aggregate tokens per
  // message. Treated as illustrative.
  let filesTokens = 0
  let toolsTokens = 0
  const parts = (assistant as any).content ?? []
  for (const part of parts) {
    if (part?.type === "tool") {
      const t = part as ToolPart
      const est = sumToolTokens(t)
      if (FILES_TOOLS.has(t.tool)) filesTokens += est
      else toolsTokens += est
    }
  }
  const reasoning = assistant.tokens.reasoning
  const output = assistant.tokens.output
  const cacheTotal = assistant.tokens.cache.read + assistant.tokens.cache.write
  const inputTotal = assistant.tokens.input
  const prompt = Math.max(0, inputTotal + cacheTotal - filesTokens - toolsTokens)
  return {
    thinking: reasoning,
    files: filesTokens,
    tools: toolsTokens,
    output,
    prompt,
    total: reasoning + output + filesTokens + toolsTokens + prompt,
  }
}

interface Segment {
  key: string
  label: string
  tokens: number
  color: "accent" | "info" | "success" | "warning" | "muted"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  const lastAssistant = createMemo(() => {
    const messages = props.api.state.session.messages(props.session_id)
    return messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
  })

  const categorization = createMemo(() => {
    const a = lastAssistant()
    if (!a) return null
    return categorizeTokens(a)
  })

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
      { key: "thinking", label: "Thinking", tokens: cat.thinking, color: "accent" },
      { key: "files", label: "Files", tokens: cat.files, color: "success" },
      { key: "tools", label: "Tools", tokens: cat.tools, color: "warning" },
      { key: "output", label: "Output", tokens: cat.output, color: "info" },
      { key: "prompt", label: "Prompt", tokens: cat.prompt, color: "muted" },
    ]
  })

  const segColor = (color: Segment["color"]): string => {
    const t = theme()
    if (color === "accent") return toHex(t.accent)
    if (color === "info") return toHex(t.info)
    if (color === "success") return toHex(t.success)
    if (color === "warning") return toHex(t.warning)
    if (color === "muted") return toHex(t.textMuted)
    return toHex(t.text)
  }

  const BAR_WIDTH = 18

  return (
    <box>
      <text fg={toHex(theme().primary)}>
        <b>CONTEXT</b>
      </text>
      <Show
        when={categorization()}
        fallback={
          <text fg={toHex(theme().textMuted)} marginTop={1}>
            no data
          </text>
        }
      >
        {(tb) => (
          <>
            <text fg={toHex(theme().textMuted)} marginTop={1}>
              {tb().total.toLocaleString()} used
              {contextPercent() !== null ? ` · ${contextPercent()}% of context` : ""}
            </text>
            <Show when={tb().total > 0}>
              <box flexDirection="row" marginTop={1} gap={0}>
                <For each={segments().filter((s) => s.tokens > 0)}>
                  {(seg) => {
                    const cells = Math.max(1, Math.round((seg.tokens / tb().total) * BAR_WIDTH))
                    return <text fg={segColor(seg.color)}>{"█".repeat(cells)}</text>
                  }}
                </For>
                <text fg={toHex(theme().textMuted)}>
                  {"░".repeat(
                    Math.max(
                      0,
                      BAR_WIDTH - segments().filter((s) => s.tokens > 0).reduce(
                        (sum, seg) => sum + Math.max(1, Math.round((seg.tokens / tb().total) * BAR_WIDTH)),
                        0,
                      ),
                    ),
                  )}
                </text>
              </box>
            </Show>
            <box flexDirection="column" marginTop={1} gap={0}>
              <For each={segments().filter((s) => s.tokens > 0)}>
                {(seg) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={segColor(seg.color)}>■</text>
                    <text fg={toHex(theme().textMuted)}>
                      {seg.label}: {seg.tokens.toLocaleString()}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </>
        )}
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
