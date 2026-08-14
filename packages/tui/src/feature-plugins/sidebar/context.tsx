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

  let breakdown: Record<string, number> | undefined
  // The billing assistant's step-finish part may carry a per-source token
  // breakdown ({ base, agent, user, environment, instructions, skills,
  // codegraph, orchestration, structuredOutput, tools }) from the provider.
  // The segments() memo folds these keys into the consolidated rows.
  for (const part of partsGetter(billingAssistant.id)) {
    if (!part || (part as any).type !== "step-finish") continue
    const bd = (part as any).tokens?.breakdown
    if (bd && typeof bd === "object" && Object.keys(bd).length > 0) {
      breakdown = { ...(bd as Record<string, number>) }
      break
    }
  }

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
  const totalCache = cacheRead + cacheWrite

  // Raw heuristic estimates (unclamped — buildSegments clamps them against
  // the un-attributed, non-cached input so rows never overlap cache).
  return {
    thinking: reasoning,
    files: filesTokens,
    tools: toolsTokens,
    output,
    userMessages: userTokens,
    subagents: subagentTokens,
    cacheRead: 0,
    cacheWrite: 0,
    breakdown,
    cache: totalCache,
    inputTotal,
    totalCache,
    // Full context the model saw: input (incl. cached reads) + output +
    // reasoning. This is the header value and the percentage denominator.
    basis: inputTotal + totalCache,
    total: inputTotal + totalCache + output + reasoning,
  }
}

interface Segment {
  key: string
  label: string
  tokens: number
  color: "primary" | "accent" | "info" | "success" | "warning" | "muted"
}

// Provider breakdown keys -> target consolidated row. Keys with no entry are
// ignored; the target rows render in the stable segment order below.
const BREAKDOWN_MERGE: ReadonlyArray<[string, Segment["key"]]> = [
  ["base", "system"],
  ["agent", "system"],
  ["user", "system"],
  ["environment", "system"],
  ["instructions", "system"],
  ["skills", "system"],
  ["structuredOutput", "system"],
  ["codegraph", "codegraphOrchestration"],
  ["orchestration", "codegraphOrchestration"],
  ["tools", "toolDefinitions"],
]

const mergeBreakdown = (
  breakdown: Record<string, number> | undefined,
): Partial<Record<Segment["key"], number>> => {
  const merged: Partial<Record<Segment["key"], number>> = {}
  if (!breakdown) return merged
  for (const [key, target] of BREAKDOWN_MERGE) {
    const tokens = breakdown[key]
    if (tokens === undefined || tokens <= 0) continue
    merged[target] = (merged[target] ?? 0) + tokens
  }
  return merged
}

// Residual after the consolidated rows: "Other" appears only when genuinely
// unaccounted (> 5% of the total context), never negative.
const withResidual = (segments: ReadonlyArray<Segment>, total: number): Segment[] => {
  const accounted = segments.reduce((sum, s) => sum + s.tokens, 0)
  const residual = Math.max(0, total - accounted)
  if (residual / total > 0.05) {
    return [...segments, { key: "other", label: "Other", tokens: residual, color: "info" }]
  }
  return [...segments]
}

// Design B: strictly non-overlapping rows that partition the total context
// (input + cache + output + reasoning). Provider breakdown rows are the
// authoritative attribution; heuristic buckets clamp to the un-attributed,
// NON-cached input so they never double-count cache; cache is its own row.
type Categorization = NonNullable<ReturnType<typeof categorizeTokens>>

const buildSegments = (cat: Categorization): Segment[] => {
  const breakdownTokens = mergeBreakdown(cat.breakdown)
  const system = breakdownTokens.system ?? 0
  const codegraphOrchestration = breakdownTokens.codegraphOrchestration ?? 0
  const toolDefinitions = breakdownTokens.toolDefinitions ?? 0
  const breakdownSum = system + codegraphOrchestration + toolDefinitions

  // The heuristic buckets estimate message-part content that includes cached
  // portions; clamp them to what is left of input after the provider's own
  // attribution, the user messages, and the cached reads have taken their
  // share. In cache-heavy sessions this remainder is ~0 and the rows
  // correctly report nothing — the bar tells the truth via the Cache row.
  let remaining = Math.max(0, cat.inputTotal - breakdownSum - cat.userMessages - cat.cache)
  const files = Math.min(cat.files, remaining)
  remaining = Math.max(0, remaining - files)
  const tools = Math.min(cat.tools, remaining)
  remaining = Math.max(0, remaining - tools)
  const subagents = Math.min(cat.subagents, remaining)
  remaining = Math.max(0, remaining - subagents)
  const users = Math.min(cat.userMessages, remaining)

  return withResidual(
    [
      { key: "system", label: "System", tokens: system, color: "muted" },
      { key: "codegraphOrchestration", label: "Codegraph & Orchestration", tokens: codegraphOrchestration, color: "info" },
      { key: "toolDefinitions", label: "Tool Definitions", tokens: toolDefinitions, color: "info" },
      { key: "toolCalls", label: "Tool Calls", tokens: tools, color: "warning" },
      { key: "files", label: "Files", tokens: files, color: "success" },
      { key: "subagents", label: "Subagents", tokens: subagents, color: "muted" },
      { key: "conversation", label: "Conversation", tokens: users, color: "accent" },
      { key: "cache", label: "Cache", tokens: cat.cache, color: "info" },
      { key: "output", label: "Output", tokens: cat.thinking + cat.output, color: "primary" },
    ],
    cat.total,
  )
}

// Exported for unit testing — not part of the public API.
export const __test = {
  categorizeTokens,
  sumToolTokens,
  estimateTokens,
  allocateBarWidths,
  taskSpawnPromptTokens,
  mergeBreakdown,
  withResidual,
  buildSegments,
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
    return buildSegments(cat)
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
