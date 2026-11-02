import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, For, Show } from "solid-js"
import { allocateBarWidths, categorizeTokens, formatTokensCompact, type TokenBreakdown } from "../../data/tokens"
import { formatMoney } from "../../data/format"
import { palette, type Palette } from "../../theme"

const BAR_WIDTH = 24

type SegmentColor = "muted" | "accent" | "info" | "success" | "warning" | "primary"

interface Segment {
  readonly key: string
  readonly label: string
  readonly tokens: number
  readonly color: SegmentColor
}

export function tokenSegments(breakdown: TokenBreakdown): Segment[] {
  return [
    { key: "user", label: "User", tokens: breakdown.userMessages, color: "muted" },
    { key: "thinking", label: "Thinking", tokens: breakdown.thinking, color: "accent" },
    // Residual bucket: system prompt, tool definitions, agent prompt and
    // anything the heuristics could not attribute to a named call.
    { key: "prompt", label: "Other", tokens: breakdown.prompt, color: "info" },
    { key: "files", label: "Files", tokens: breakdown.files, color: "success" },
    { key: "tools", label: "Tools", tokens: breakdown.tools, color: "warning" },
    { key: "subagents", label: "Subagents", tokens: breakdown.subagents, color: "muted" },
    { key: "output", label: "Output", tokens: breakdown.output, color: "primary" },
  ]
}

function segmentColor(theme: Palette, color: SegmentColor) {
  if (color === "accent") return theme.accent
  if (color === "info") return theme.info
  if (color === "success") return theme.success
  if (color === "warning") return theme.warning
  if (color === "primary") return theme.primary
  return theme.muted
}

/**
 * Ported from v1 `feature-plugins/sidebar/context.tsx`: a stacked bar, one row per
 * token category, and the session's cost. It replaces the host's compact panel.
 */
export function ContextBreakdownPanel(props: { readonly context: Context; readonly sessionID: string }) {
  const theme = () => palette(props.context.theme)
  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const breakdown = createMemo(() => categorizeTokens(messages()))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))
  const limit = createMemo(() => {
    const model = breakdown()?.model
    if (!model) return undefined
    const session = props.context.data.session.get(props.sessionID)
    const models = props.context.data.location.model.list(session?.location ?? props.context.location)
    const context = models?.find((item) => item.providerID === model.providerID && item.id === model.id)?.limit.context
    return context && context > 0 ? context : undefined
  })
  const percent = createMemo(() => {
    const total = breakdown()?.total
    const denominator = limit()
    if (!total || !denominator) return undefined
    return Math.round((total / denominator) * 100)
  })
  const bar = createMemo(() => {
    const value = breakdown()
    if (!value) return { segments: [] as Array<Segment & { width: number }>, empty: BAR_WIDTH }
    const active = tokenSegments(value).filter((segment) => segment.tokens > 0)
    const widths = allocateBarWidths(active, value.total, limit() ?? value.total, BAR_WIDTH)
    const used = widths.reduce((sum, width) => sum + width, 0)
    return {
      segments: active.map((segment, index) => ({ ...segment, width: widths[index] ?? 0 })),
      empty: Math.max(0, BAR_WIDTH - used),
    }
  })

  return (
    <Show when={breakdown()}>
      {(value) => (
        <box flexDirection="column" gap={0}>
          <box flexDirection="row" gap={1} alignItems="center">
            <text fg={theme().primary}>
              <b>CONTEXT</b>
            </text>
            <text fg={theme().muted}>
              {formatTokensCompact(value().total)}
              <Show when={limit()}>
                {(max) => (
                  <>
                    {" "}
                    / {formatTokensCompact(max())} ({percent() ?? 0}%)
                  </>
                )}
              </Show>
            </text>
          </box>
          <box flexDirection="row" width={BAR_WIDTH} height={1}>
            <For each={bar().segments}>
              {(segment) => (
                <box
                  width={segment.width}
                  flexShrink={0}
                  height={1}
                  backgroundColor={segmentColor(theme(), segment.color)}
                />
              )}
            </For>
            <box width={bar().empty} flexShrink={0} height={1} backgroundColor={theme().surfaceHigh} />
          </box>
          <For each={tokenSegments(value()).filter((segment) => segment.tokens > 0)}>
            {(segment) => (
              <box flexDirection="row" justifyContent="space-between" width="100%">
                <box flexDirection="row" gap={1}>
                  <text fg={segmentColor(theme(), segment.color)}>■</text>
                  <text fg={theme().text}>{segment.label}</text>
                </box>
                <box flexDirection="row" gap={1}>
                  <text fg={theme().text}>{formatTokensCompact(segment.tokens)}</text>
                  <text fg={theme().muted}>
                    {value().total === 0 ? "0.0" : ((segment.tokens / value().total) * 100).toFixed(1)}%
                  </text>
                </box>
              </box>
            )}
          </For>
          <Show when={cost() > 0}>
            <text fg={theme().muted}>{formatMoney(cost())} spent</text>
          </Show>
        </box>
      )}
    </Show>
  )
}
