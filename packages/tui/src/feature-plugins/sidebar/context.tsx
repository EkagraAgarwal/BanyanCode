/** @jsxImportSource @opentui/solid */
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"
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
  "apply_patch",
  "code-find",
  "code_find",
  "structural-queries",
])
const TOKEN_HEURISTIC_CHARS_PER_TOKEN = 4

const estimateTokens = (s: string): number =>
  s.length === 0 ? 0 : Math.max(1, Math.ceil(s.length / TOKEN_HEURISTIC_CHARS_PER_TOKEN))

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

const taskSpawnPromptTokens = (tool: any): number => {
  const s = tool?.state ?? tool
  if (!s) return 0
  const input = s.input
  if (input && typeof input === "object" && typeof input.prompt === "string") {
    return estimateTokens(input.prompt)
  }
  if (typeof input === "string") return estimateTokens(input)
  return 0
}

const sumToolTokens = (tool: any): number => {
  const s = tool?.state ?? tool
  if (!s) return 0
  if (s.status === "pending" || s.status === "running") {
    if (s.input) {
      return estimateTokens(typeof s.input === "string" ? s.input : JSON.stringify(s.input))
    }
    return 0
  }
  let total = 0
  if (s.input) {
    total += estimateTokens(typeof s.input === "string" ? s.input : JSON.stringify(s.input))
  }
  const hasOutput = s.output && typeof s.output === "string"
  if (hasOutput) {
    total += estimateTokens(s.output)
  }
  if (Array.isArray(s.content) && !hasOutput) {
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

const isSyntheticText = (p: any): boolean =>
  p?.synthetic === true || p?.ignored === true

const textFromUserPart = (p: any): string => {
  if (typeof p?.text === "string") return p.text
  if (Array.isArray(p?.content)) {
    return p.content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
      .join(" ")
  }
  return ""
}

const isAssistant = (m: Message): m is AssistantMessage =>
  (m as any).role === "assistant" || (m as any).type === "assistant"

const allocateBarWidths = (
  segments: ReadonlyArray<{ tokens: number }>,
  totalTokens: number,
  denom: number,
  barWidth: number,
): number[] => {
  const active = segments.filter((s) => s.tokens > 0)
  if (active.length === 0 || totalTokens === 0 || denom <= 0) {
    return active.map(() => 0)
  }
  const targetUsed = Math.min(barWidth, Math.max(0, Math.round((totalTokens / denom) * barWidth)))
  if (targetUsed === 0) return active.map(() => 0)

  const fractions = active.map((s) => (s.tokens / totalTokens) * targetUsed)
  const floors = fractions.map((f) => Math.floor(f))
  let leftover = targetUsed - floors.reduce((sum, w) => sum + w, 0)
  const remainders = fractions
    .map((f, i) => ({ i, rem: f - floors[i] }))
    .sort((a, b) => b.rem - a.rem)
  const widths = [...floors]
  for (let r = 0; r < leftover; r++) {
    widths[remainders[r % remainders.length].i]++
  }
  return widths
}

const categorizeTokens = (
  messages: ReadonlyArray<Message>,
  partsGetter: (messageID: string) => ReadonlyArray<Part>,
) => {
  const assistants: AssistantMessage[] = []
  for (const m of messages) {
    if (isAssistant(m)) assistants.push(m)
  }
  if (assistants.length === 0) return null

  const billingAssistant =
    assistants.findLast((a) => (a.tokens?.input ?? 0) > 0) ?? assistants[assistants.length - 1]
  const billingIdx = messages.findIndex((m) => isAssistant(m) && m.id === billingAssistant.id)

  let filesTokens = 0
  let toolsTokens = 0
  let subagentTokens = 0
  let userTokens = 0
  let reasoning = 0
  let output = 0

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const role = (m as any).role ?? (m as any).type

    if (role === "user") {
      if (i < billingIdx) {
        const u = m as any
        const parts = partsGetter(u.id)
        let text = ""
        for (const p of parts) {
          if (!p) continue
          if ((p as any).type === "text" && !isSyntheticText(p)) {
            text += text ? " " + textFromUserPart(p) : textFromUserPart(p)
          }
        }
        if (!text) {
          if (typeof u.text === "string") text = u.text
          else if (typeof u.prompt === "string") text = u.prompt
        }
        if (text) userTokens += estimateTokens(text)
      }
      continue
    }

    if (!isAssistant(m)) continue
    const a = m

    reasoning += a.tokens?.reasoning ?? 0
    output += a.tokens?.output ?? 0

    if (i > billingIdx) continue

    const parts = partsGetter(a.id)
    for (const part of parts) {
      if (!part || (part as any).type !== "tool") continue
      const t = part as any
      const toolName = t.name ?? t.tool ?? ""
      if (!toolName) continue
      if (toolName === "task") {
        subagentTokens += taskSpawnPromptTokens(t)
        continue
      }
      const est = sumToolTokens(t)
      if (FILES_TOOLS.has(toolName)) filesTokens += est
      else toolsTokens += est
    }
  }

  const tokens = billingAssistant.tokens ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  const inputTotal = tokens.input ?? 0
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0

  const heuristicBuckets = filesTokens + toolsTokens + subagentTokens + userTokens
  const prompt = Math.max(0, inputTotal - Math.min(heuristicBuckets, inputTotal))
  const files = Math.min(filesTokens, inputTotal)
  const tools = Math.min(toolsTokens, Math.max(0, inputTotal - files))
  const subagents = Math.min(subagentTokens, Math.max(0, inputTotal - files - tools))
  const users = Math.min(userTokens, Math.max(0, inputTotal - files - tools - subagents))

  return {
    thinking: reasoning,
    files,
    tools,
    output,
    prompt,
    userMessages: users,
    subagents,
    cacheRead,
    cacheWrite,
    total: inputTotal + output + reasoning + cacheRead + cacheWrite,
  }
}

// Exported for unit testing — not part of the public API.
export const __test = { categorizeTokens, sumToolTokens, estimateTokens, allocateBarWidths, taskSpawnPromptTokens }

interface Segment {
  key: string
  label: string
  tokens: number
  color: "primary" | "accent" | "info" | "success" | "warning" | "muted"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  const messages = createMemo(() => props.api.state.session.messages(props.session_id))

  const partsGetter = createMemo(() => {
    void props.api.state.session.messages(props.session_id)
    return (messageID: string) => props.api.state.part(messageID)
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast(
      (item): item is AssistantMessage =>
        isAssistant(item) &&
        "tokens" in item &&
        !!(item as any).tokens &&
        (((item as any).tokens.output ?? 0) > 0 || ((item as any).tokens.input ?? 0) > 0),
    )
  })

  const categorization = createMemo(() => categorizeTokens(messages(), partsGetter()))

  const modelContextLimit = createMemo(() => {
    const last = lastAssistant()
    if (!last) return null
    const provider = props.api.state.provider.find((p) => p.id === last.providerID)
    return provider?.models[last.modelID]?.limit?.context ?? null
  })

  const limit = createMemo(() => {
    const l = modelContextLimit()
    return l && l > 0 ? l : null
  })

  const hasLimit = createMemo(() => limit() !== null)

  const contextPercent = createMemo(() => {
    const tb = categorization()
    const l = limit()
    if (!tb || !l) return null
    return Math.round((tb.total / l) * 100)
  })

  const barDenominator = createMemo(() => {
    const l = limit()
    if (l) return l
    const tb = categorization()
    return tb?.total && tb.total > 0 ? tb.total : 1
  })

  const segments = createMemo<Segment[]>(() => {
    const cat = categorization()
    if (!cat) return []
    const cache = cat.cacheRead + cat.cacheWrite
    return [
      { key: "user", label: "User", tokens: cat.userMessages, color: "muted" },
      { key: "thinking", label: "Thinking", tokens: cat.thinking, color: "accent" },
      { key: "prompt", label: "Prompt", tokens: cat.prompt, color: "info" },
      { key: "files", label: "Files", tokens: cat.files, color: "success" },
      { key: "tools", label: "Tools", tokens: cat.tools, color: "warning" },
      { key: "subagents", label: "Subagents", tokens: cat.subagents, color: "muted" },
      { key: "output", label: "Output", tokens: cat.output, color: "primary" },
      { key: "cache", label: "Cache", tokens: cache, color: "info" },
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

  const barLayout = createMemo(() => {
    const tb = categorization()
    const active = segments().filter((s) => s.tokens > 0)
    if (!tb || active.length === 0) {
      return { segments: [] as Array<Segment & { width: number }>, empty: BAR_WIDTH }
    }
    const widths = allocateBarWidths(active, tb.total, barDenominator(), BAR_WIDTH)
    const used = widths.reduce((sum, w) => sum + w, 0)
    return {
      segments: active.map((seg, i) => ({ ...seg, width: widths[i] ?? 0 })),
      empty: Math.max(0, BAR_WIDTH - used),
    }
  })

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={toHex(theme().primary)}>
          <b>CONTEXT</b>
        </text>
        <Show when={categorization()}>
          {(tb) => (
            <text fg={toHex(theme().textMuted)}>
              {" "}{formatTokensCompact(tb().total)}
              <Show when={hasLimit()}>
                {" "} / {formatTokensCompact(limit()!)} ({contextPercent() ?? 0}%)
              </Show>
            </text>
          )}
        </Show>
      </box>
      <Show when={categorization()}>
        {(tb) => (
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
                <For each={barLayout().segments}>
                  {(seg) => (
                    <box
                      width={seg.width}
                      flexShrink={0}
                      backgroundColor={segColor(seg.color)}
                      height={1}
                    />
                  )}
                </For>
              </Show>
              <box
                width={barLayout().empty}
                flexShrink={0}
                backgroundColor={toHex(theme().backgroundElement)}
                height={1}
              />
            </box>
            <box flexDirection="row" marginTop={0} width="100%">
              <text>
                <span style={{ fg: toHex(theme().text) }}>Used {formatTokensCompact(tb().total)}</span>
                <Show when={hasLimit()}>
                  <span style={{ fg: toHex(theme().textMuted) }}>
                    {" "}/ {formatTokensCompact(limit()!)} in context
                  </span>
                </Show>
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
