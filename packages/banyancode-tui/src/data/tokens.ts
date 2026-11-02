import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"

/**
 * Ported from v1 `feature-plugins/sidebar/context.tsx`. v1 read message parts
 * through a separate `api.state.part(messageID)` store; v2 carries the parts
 * inline on the assistant message, so the same heuristics run over
 * `message.content` instead.
 */
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

const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

export function formatTokensCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(value)
}

function asText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  return JSON.stringify(value)
}

export function taskSpawnPromptTokens(tool: SessionMessageAssistantTool): number {
  const input = tool.state.input
  if (typeof input !== "object" || input === null) return estimateTokens(asText(input))
  return estimateTokens(asText((input as Record<string, unknown>).prompt))
}

export function sumToolTokens(tool: SessionMessageAssistantTool): number {
  const state = tool.state
  let total = estimateTokens(asText(state.input))
  if (state.status === "streaming" || state.status === "running") return total
  for (const item of state.content ?? []) {
    if (item.type === "text") total += estimateTokens(item.text)
  }
  if (state.status === "error") total += estimateTokens(state.error.message)
  return total
}

export interface TokenBreakdown {
  readonly thinking: number
  readonly files: number
  readonly tools: number
  readonly subagents: number
  readonly userMessages: number
  readonly prompt: number
  readonly output: number
  readonly total: number
  readonly model: { readonly providerID: string; readonly id: string } | undefined
}

export function categorizeTokens(messages: ReadonlyArray<SessionMessageInfo>): TokenBreakdown | undefined {
  const assistants = messages.filter((message) => message.type === "assistant")
  if (assistants.length === 0) return undefined
  const billing =
    assistants.findLast((message) => (message.tokens?.input ?? 0) > 0) ?? assistants[assistants.length - 1]!
  const billingIndex = messages.findIndex((message) => message.id === billing.id)

  let filesTokens = 0
  let toolsTokens = 0
  let subagentTokens = 0
  let userTokens = 0
  let reasoning = 0
  let output = 0

  messages.forEach((message, index) => {
    if (message.type === "user") {
      if (index < billingIndex && message.text) userTokens += estimateTokens(message.text)
      return
    }
    if (message.type !== "assistant") return
    reasoning += message.tokens?.reasoning ?? 0
    output += message.tokens?.output ?? 0
    if (index > billingIndex) return
    for (const item of message.content) {
      if (item.type !== "tool") continue
      if (item.name === "task") {
        subagentTokens += taskSpawnPromptTokens(item)
        continue
      }
      const estimate = sumToolTokens(item)
      if (FILES_TOOLS.has(item.name)) filesTokens += estimate
      else toolsTokens += estimate
    }
  })

  const tokens = billing.tokens
  const inputTotal = tokens?.input ?? 0
  const cacheRead = tokens?.cache.read ?? 0
  const cacheWrite = tokens?.cache.write ?? 0
  // Cache is implicit in basis; the heuristic buckets are clamped to it so a
  // cache-heavy conversation does not collapse every category to zero.
  const basis = inputTotal + cacheRead + cacheWrite
  const heuristic = filesTokens + toolsTokens + subagentTokens + userTokens
  const prompt = Math.max(0, basis - heuristic)
  const files = Math.min(filesTokens, basis)
  const tools = Math.min(toolsTokens, Math.max(0, basis - files))
  const subagents = Math.min(subagentTokens, Math.max(0, basis - files - tools))
  const userMessages = Math.min(userTokens, Math.max(0, basis - files - tools - subagents))

  return {
    thinking: reasoning,
    files,
    tools,
    subagents,
    userMessages,
    prompt,
    output,
    total: inputTotal + output + reasoning + cacheRead + cacheWrite,
    model: { providerID: billing.model.providerID, id: billing.model.id },
  }
}

/** Largest-remainder allocation so the bar spends exactly the used column count. */
export function allocateBarWidths(
  segments: ReadonlyArray<{ readonly tokens: number }>,
  totalTokens: number,
  denominator: number,
  barWidth: number,
): number[] {
  const active = segments.filter((segment) => segment.tokens > 0)
  if (active.length === 0 || totalTokens === 0 || denominator <= 0) return active.map(() => 0)
  const targetUsed = Math.min(barWidth, Math.max(0, Math.round((totalTokens / denominator) * barWidth)))
  if (targetUsed === 0) return active.map(() => 0)
  const fractions = active.map((segment) => (segment.tokens / totalTokens) * targetUsed)
  const floors = fractions.map((fraction) => Math.floor(fraction))
  const leftover = targetUsed - floors.reduce((sum, width) => sum + width, 0)
  const remainders = fractions
    .map((fraction, index) => ({ index, remainder: fraction - floors[index]! }))
    .sort((left, right) => right.remainder - left.remainder)
  const widths = [...floors]
  for (let step = 0; step < leftover; step++) {
    const target = remainders[step % remainders.length]!
    widths[target.index] = widths[target.index]! + 1
  }
  return widths
}
