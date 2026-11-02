import type { RGBA } from "@opentui/core"
import type { ChildState } from "../../data/mesh"
import type { ToolCall } from "../../data/messages"
import { formatDuration, formatMoney, formatTokens, truncate } from "../../data/format"
import { sproutFrame } from "../status/sprout"
import type { GroveNested, GrovePaneView } from "./data"

/**
 * Row painters. Each pane is drawn as exact-width strings rather than nested
 * borders so the title/state/footer line up with the branch row above it, and
 * so a clipped pane never corrupts its neighbours.
 */

export interface GroveSpan {
  readonly text: string
  readonly color: RGBA
  readonly bold?: boolean
}

export interface GroveRow {
  readonly spans: readonly GroveSpan[]
}

export interface GrovePaneColors {
  readonly border: RGBA
  readonly text: RGBA
  readonly soft: RGBA
  readonly dim: RGBA
  readonly faint: RGBA
  readonly accent: RGBA
  readonly done: RGBA
  readonly wood: RGBA
  readonly highlight: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly bright: RGBA
}

/** Tool rows kept per pane: the newest calls, so the current one is visible. */
export const GROVE_TOOL_ROWS = 5
export const GROVE_OUTPUT_ROWS = 3
export const GROVE_NESTED_ROWS = 3

export function stateLabel(state: ChildState, killed = false): string {
  if (state === "failed") return killed ? "KILLED" : "FAILED"
  if (state === "waiting") return "WAITING"
  if (state === "running") return "ACTIVE"
  return "DONE"
}

function contentRow(spans: readonly GroveSpan[], inner: number, padColor: RGBA): GroveRow {
  const fitted = fitSpans(spans, inner, padColor)
  return { spans: [{ text: "│ ", color: padColor }, ...fitted, { text: " │", color: padColor }] }
}

function blankRow(width: number, color: RGBA): GroveRow {
  if (width < 2) return { spans: [{ text: " ".repeat(Math.max(0, width)), color }] }
  return {
    spans: [
      { text: "│", color },
      { text: " ".repeat(width - 2), color },
      { text: "│", color },
    ],
  }
}

function fitSpans(spans: readonly GroveSpan[], width: number, padColor: RGBA): GroveSpan[] {
  const out: GroveSpan[] = []
  let used = 0
  for (const span of spans) {
    if (used >= width) break
    const text = span.text.length > width - used ? truncate(span.text, width - used) : span.text
    if (text.length === 0) continue
    out.push({ ...span, text })
    used += text.length
  }
  if (used < width) out.push({ text: " ".repeat(width - used), color: padColor })
  return out
}

function topRow(input: {
  readonly width: number
  readonly name: string
  readonly label: string
  readonly selected: boolean
  readonly border: RGBA
  readonly title: RGBA
  readonly state: RGBA
}): GroveRow {
  const head = input.selected ? "╭› " : "╭─ "
  const nameMax = Math.max(1, input.width - 8 - input.label.length)
  const name = truncate(input.name, nameMax)
  const fill = Math.max(1, input.width - 7 - name.length - input.label.length)
  return {
    spans: [
      { text: head, color: input.border },
      { text: name, color: input.title, bold: true },
      { text: " ", color: input.border },
      { text: "─".repeat(fill), color: input.border },
      { text: input.label, color: input.state, bold: true },
      { text: "──╮", color: input.border },
    ],
  }
}

function bottomRow(width: number, color: RGBA): GroveRow {
  return { spans: [{ text: `╰${"─".repeat(Math.max(0, width - 2))}╯`, color }] }
}

function footerRow(input: {
  readonly width: number
  readonly tools: number
  readonly elapsedMs: number | undefined
  readonly cost: number
  readonly tokens: number
  readonly running: boolean
  readonly tick: number
  readonly animations: boolean
  readonly colors: GrovePaneColors
}): GroveRow {
  const inner = input.width - 4
  const right = truncate(`${formatMoney(input.cost)} · ${formatTokens(input.tokens)}`, Math.max(1, inner - 1))
  const left: GroveSpan[] = []
  if (input.running) {
    left.push({ text: `${input.animations ? sproutFrame(input.tick) : "⋯"} `, color: input.colors.highlight })
  }
  left.push({ text: `${input.tools} tool${input.tools === 1 ? "" : "s"}`, color: input.colors.dim })
  if (input.elapsedMs !== undefined) {
    left.push({ text: " · ", color: input.colors.faint })
    left.push({ text: formatDuration(input.elapsedMs), color: input.colors.dim })
  }
  const leftWidth = left.reduce((sum, span) => sum + span.text.length, 0)
  const room = inner - right.length - 1
  const clipped = leftWidth > room ? fitSpans(left, Math.max(0, room), input.colors.dim) : left
  const used = clipped.reduce((sum, span) => sum + span.text.length, 0)
  const gap = Math.max(0, inner - used - right.length)
  return {
    spans: [
      { text: "│ ", color: input.colors.border },
      ...clipped,
      { text: " ".repeat(gap), color: input.colors.dim },
      { text: right, color: input.colors.dim },
      { text: " │", color: input.colors.border },
    ],
  }
}

function toolRow(input: {
  readonly width: number
  readonly tool: ToolCall
  readonly current: boolean
  readonly index: number
  readonly tick: number
  readonly animations: boolean
  readonly colors: GrovePaneColors
}): GroveRow {
  const inner = input.width - 4
  const glyph =
    input.tool.status === "completed"
      ? "✓"
      : input.tool.status === "error"
        ? "✕"
        : input.tool.status === "running"
          ? input.animations
            ? sproutFrame(input.tick, input.index)
            : "⋯"
          : "·"
  const glyphColor =
    input.tool.status === "completed"
      ? input.colors.done
      : input.tool.status === "error"
        ? input.colors.error
        : input.tool.status === "running"
          ? input.colors.highlight
          : input.colors.faint
  return contentRow(
    [
      { text: `${glyph} `, color: glyphColor, bold: input.current },
      { text: input.tool.name, color: input.current ? input.colors.text : input.colors.dim, bold: input.current },
      ...(input.tool.args.length > 0
        ? [{ text: ` ${input.tool.args}`, color: input.current ? input.colors.soft : input.colors.dim }]
        : []),
    ],
    inner,
    input.colors.border,
  )
}

function nestedRow(input: { readonly width: number; readonly child: GroveNested; readonly colors: GrovePaneColors }): GroveRow {
  const inner = input.width - 4
  return contentRow(
    [
      { text: "  ↳ ", color: input.colors.wood },
      { text: input.child.agent, color: input.colors.text },
      { text: ` ${nestedState(input.child.state)}`, color: input.colors.dim },
    ],
    inner,
    input.colors.border,
  )
}

function nestedState(state: ChildState): string {
  if (state === "waiting") return "waiting"
  if (state === "running") return "running"
  if (state === "failed") return "failed"
  return "done"
}

export function buildPaneRows(input: {
  readonly pane: GrovePaneView
  readonly width: number
  readonly height: number
  readonly selected: boolean
  readonly tick: number
  readonly animations: boolean
  readonly colors: GrovePaneColors
  readonly border: RGBA
  readonly stateColor: RGBA
  readonly titleColor: RGBA
  readonly elapsedMs?: number | undefined
}): GroveRow[] {
  const { pane, width, colors } = input
  if (input.height < 3 || width < 6) return []
  const inner = width - 4
  const body: GroveRow[] = []
  if (pane.title !== undefined && pane.title !== "") {
    body.push(contentRow([{ text: pane.title, color: colors.soft }], inner, colors.border))
  }
  if (pane.model !== undefined && pane.model !== "") {
    body.push(contentRow([{ text: pane.model, color: colors.dim }], inner, colors.border))
  }
  if (body.length > 0) body.push(blankRow(width, colors.border))

  const shown = pane.tools.slice(-GROVE_TOOL_ROWS)
  if (pane.tools.length > shown.length) {
    body.push(contentRow([{ text: `+${pane.tools.length - shown.length} earlier`, color: colors.faint }], inner, colors.border))
  }
  shown.forEach((tool, index) =>
    body.push(
      toolRow({
        width,
        tool,
        current: pane.current?.id === tool.id && tool.status === "running",
        index,
        tick: input.tick,
        animations: input.animations,
        colors,
      }),
    ),
  )
  if (shown.length > 0) body.push(blankRow(width, colors.border))

  if (pane.state === "running" || pane.state === "waiting") {
    const lines = pane.output.slice(-GROVE_OUTPUT_ROWS)
    lines.forEach((line, index) =>
      body.push(
        contentRow(
          [{ text: line, color: index === lines.length - 1 ? colors.soft : colors.dim }],
          inner,
          colors.border,
        ),
      ),
    )
  } else if (pane.summary !== undefined && pane.summary !== "") {
    body.push(contentRow([{ text: "RETURNED", color: colors.wood, bold: true }], inner, colors.border))
    body.push(contentRow([{ text: pane.summary, color: colors.soft }], inner, colors.border))
  }

  if (pane.nested.length > 0) {
    body.push(blankRow(width, colors.border))
    pane.nested
      .slice(0, GROVE_NESTED_ROWS)
      .forEach((child) => body.push(nestedRow({ width, child, colors })))
    if (pane.nested.length > GROVE_NESTED_ROWS) {
      body.push(
        contentRow(
          [{ text: `  +${pane.nested.length - GROVE_NESTED_ROWS} more`, color: colors.faint }],
          inner,
          colors.border,
        ),
      )
    }
  }

  const bodyHeight = Math.max(0, input.height - 3)
  const rows: GroveRow[] = [
    topRow({
      width,
      name: pane.agent,
      label: stateLabel(pane.state, pane.killed),
      selected: input.selected,
      border: input.border,
      title: input.titleColor,
      state: input.stateColor,
    }),
    ...body.slice(0, bodyHeight),
  ]
  while (rows.length < input.height - 2) rows.push(blankRow(width, colors.border))
  rows.push(
    footerRow({
      width,
      tools: pane.tools.length,
      elapsedMs: input.elapsedMs,
      cost: pane.cost,
      tokens: pane.tokens,
      running: pane.state === "running",
      tick: input.tick,
      animations: input.animations,
      colors,
    }),
    bottomRow(width, input.border),
  )
  return rows
}

/** A collapsed run of same-agent children in the overflow row. */
export function buildGroupRows(input: {
  readonly width: number
  readonly height: number
  readonly agent: string
  readonly count: number
  readonly states: readonly ChildState[]
  readonly tokens: number
  readonly cost: number
  readonly selected: boolean
  readonly colors: GrovePaneColors
}): GroveRow[] {
  if (input.height < 3 || input.width < 6) return []
  const inner = input.width - 4
  const running = input.states.filter((state) => state === "running").length
  const waiting = input.states.filter((state) => state === "waiting").length
  const failed = input.states.filter((state) => state === "failed").length
  const label = running > 0 ? "ACTIVE" : waiting > 0 ? "WAITING" : failed > 0 ? "FAILED" : "DONE"
  const stateColor = failed > 0 ? input.colors.error : waiting > 0 ? input.colors.warning : running > 0 ? input.colors.accent : input.colors.faint
  const body: GroveRow[] = [
    contentRow([{ text: `${input.count} ${input.agent} branches`, color: input.colors.soft }], inner, input.colors.border),
    contentRow([{ text: "collapsed", color: input.colors.dim }], inner, input.colors.border),
    blankRow(input.width, input.colors.border),
    contentRow([{ text: "enter to expand", color: input.colors.faint }], inner, input.colors.border),
  ]
  const bodyHeight = Math.max(0, input.height - 3)
  const rows: GroveRow[] = [
    topRow({
      width: input.width,
      name: `${input.agent} ×${input.count}`,
      label,
      selected: input.selected,
      border: input.colors.border,
      title: input.colors.text,
      state: stateColor,
    }),
    ...body.slice(0, bodyHeight),
  ]
  while (rows.length < input.height - 2) rows.push(blankRow(input.width, input.colors.border))
  rows.push(
    footerRow({
      width: input.width,
      tools: 0,
      elapsedMs: undefined,
      cost: input.cost,
      tokens: input.tokens,
      running: false,
      tick: 0,
      animations: false,
      colors: input.colors,
    }),
    bottomRow(input.width, input.colors.border),
  )
  return rows
}

/** One row of the narrow selectable list. */
export function buildListRow(input: {
  readonly width: number
  readonly agent: string
  readonly state: ChildState
  readonly title: string | undefined
  readonly selected: boolean
  readonly colors: GrovePaneColors
}): GroveRow {
  const glyph = input.state === "running" ? "●" : input.state === "waiting" ? "◐" : input.state === "failed" ? "✕" : "○"
  const glyphColor =
    input.state === "running"
      ? input.colors.accent
      : input.state === "waiting"
        ? input.colors.warning
        : input.state === "failed"
          ? input.colors.error
          : input.colors.faint
  const prefix = input.selected ? "› " : "  "
  const title = input.title === undefined ? "" : ` · ${input.title}`
  return {
    spans: fitSpans(
      [
        { text: prefix, color: input.colors.bright },
        { text: `${glyph} `, color: glyphColor },
        { text: input.agent, color: input.state === "done" ? input.colors.dim : input.colors.text, bold: input.selected },
        { text: title, color: input.colors.dim },
      ],
      Math.max(0, input.width),
      input.colors.dim,
    ),
  }
}
