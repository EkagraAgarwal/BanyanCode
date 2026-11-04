import type { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { formatTokens, truncate } from "../../../data/format"
import { stateGlyph, type RosterRow, type ToolLetter } from "../../../data/understory"
import {
  durationText,
  nowText,
  spanAt,
  stateAt,
  tokenBuckets,
  type AgentSpan,
} from "../../../data/understory-spans"
import { mix } from "../../../motion"
import { kindColor, type Palette } from "../../../theme"
import type { Grid } from "../cells"
import { columnAt, type TraceWindow } from "../layout"

/**
 * Everything the Trace lens paints, as pure functions over a `Grid`. The
 * component in `./index` owns reactivity and hit routing; nothing here reads a
 * signal, the clock or the renderer, so a test can build a frame and assert on
 * its cells.
 *
 * Geometry follows the mockup: one blank column at each edge, the history
 * carrying the timeline and roughly a third of the width given to the now
 * column on the right.
 */

/** The now column's share of the lens: `labelW = clamp(round(W * .31), 12, 36)`. */
export const NOW_FRACTION = 0.31
export const NOW_MIN = 12
export const NOW_MAX = 36
/** Sub-cell columns per terminal cell, so two spans share one cell. */
export const SUB = 8
/** Tokens per second that fills the token bar rows; larger rates rescale. */
export const RATE_TOP = 170

/**
 * The lane painter's scratch column array: one lane is painted at a time, so
 * the array is reused instead of allocated per lane per frame.
 */
let laneScratch: Array<RGBA | undefined> = []
function lanePaint(size: number): Array<RGBA | undefined> {
  if (laneScratch.length < size) laneScratch = new Array<RGBA | undefined>(size)
  laneScratch.fill(undefined, 0, size)
  return laneScratch
}

export interface TraceLayout {  /** First history column. */
  readonly x: number
  /** Usable columns between the two blank edge columns. */
  readonly inner: number
  /** Columns of timeline. */
  readonly history: number
  /** First now-column cell. */
  readonly labelX: number
  /** Now-column cells. */
  readonly label: number
}

export function traceLayout(width: number): TraceLayout {
  const inner = Math.max(1, Math.floor(width) - 2)
  const wanted = Math.max(NOW_MIN, Math.min(NOW_MAX, Math.round(inner * NOW_FRACTION)))
  const label = Math.min(wanted, Math.max(0, inner - 1))
  const history = Math.max(1, inner - label - 1)
  return { x: 1, inner, history, labelX: 1 + history + 1, label: Math.max(0, inner - history - 1) }
}

/** `1:24` from the run origin, the ruler's ticks and the playhead label. */
export function traceClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** Candidate tick spacings in seconds, coarsening until the labels stop colliding. */
export const TICK_STEPS: readonly number[] = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** The tick spacing that leaves at least nine columns between labels. */
export function tickStep(spanMs: number, columns: number): number {
  const span = Math.max(0.001, spanMs / 1000)
  for (const step of TICK_STEPS) if ((step / span) * Math.max(1, columns) >= 9) return step * 1000
  return 1200_000
}

/** Absolute tick times inside the window, step-aligned. */
export function tickMarks(window: TraceWindow, columns: number): number[] {
  const step = tickStep(window.b - window.a, columns)
  const marks: number[] = []
  for (let t = Math.ceil(window.a / step) * step; t <= window.b; t += step) marks.push(t)
  return marks
}

const column = (window: TraceWindow, columns: number, t: number) => columnAt(window, columns, t)

/**
 * The overview strip: stacked token rate per agent over the whole run, each
 * cell split at 1/8-cell vertical precision so two layers share one row. The
 * lower layer is the cell's foreground, the upper one its background.
 */
export interface OverviewInput {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly rows: number
  /** `rates[column][agent]`, tokens per second. */
  readonly rates: readonly (readonly number[])[]
  readonly colors: readonly RGBA[]
  readonly selected: number
  /** Absolute time the first column starts at. */
  readonly from: number
  /** Absolute time the last column ends at. */
  readonly to: number
  readonly window: TraceWindow
  readonly playhead: number
  readonly replay: boolean
  readonly theme: Palette
}

export function drawOverview(grid: Grid, input: OverviewInput): void {
  const { x, y, width, rows, theme } = input
  if (width <= 0 || rows <= 0) return
  const ground = theme.background
  const span = Math.max(1, input.to - input.from)
  const layers: Array<Array<{ index: number; lo: number; hi: number }> | undefined> = []
  let peak = 0

  for (let c = 0; c < width; c += 1) {
    const t = input.from + ((c + 0.5) / width) * span
    if (t > input.playhead) {
      layers.push(undefined)
      continue
    }
    const rates = input.rates[c] ?? []
    let total = 0
    const stack: Array<{ index: number; lo: number; hi: number }> = []
    rates.forEach((rate, agent) => {
      if (rate <= 0 || input.colors[agent] === undefined) return
      stack.push({ index: agent, lo: total, hi: total + rate })
      total += rate
    })
    if (total > peak) peak = total
    layers.push(stack)
  }

  // Two colours per agent for the whole frame: its in-window colour (full for
  // the selected row, three-fifths blended for the rest) and the dimmed blend
  // for the part outside the visible window. Hoisting them turns one `mix` pair
  // per cell into one per agent.
  const inside = input.colors.map((color, agent) =>
    agent === input.selected ? color : mix(ground, color, 0.62),
  )
  const outside = inside.map((color) => mix(ground, color, 0.38))

  const scale = (rows * SUB) / Math.max(1, peak)
  const start = Math.round(((input.window.a - input.from) / span) * (width - 1))
  const end = Math.round(((input.window.b - input.from) / span) * (width - 1))
  const dimmed = start > 0 || end < width - 1
  const edges = input.replay ? theme.sky : theme.border

  for (let c = 0; c < width; c += 1) {
    for (let row = 0; row < rows; row += 1) grid.setCell(x + c, y + row, " ", theme.text, ground)
    const stack = layers[c]
    if (stack === undefined || stack.length === 0) continue
    const inWindow = c >= start && c <= end

    for (let row = 0; row < rows; row += 1) {
      const lo = row * SUB
      const hi = lo + SUB
      const rowY = y + rows - 1 - row
      const first = stack.find((layer) => layer.hi * scale > lo && layer.lo * scale < hi)
      if (first === undefined) continue
      const next = stack[stack.indexOf(first) + 1]
      const top = Math.min(first.hi * scale, hi)
      const eighths = Math.max(0, Math.min(SUB, Math.round(top - lo)))
      const fg = inWindow ? inside[first.index]! : outside[first.index]!
      const bg = next === undefined ? ground : inWindow ? inside[next.index]! : outside[next.index]!
      if (eighths >= SUB && next === undefined) grid.setCell(x + c, rowY, "█", fg, ground)
      else grid.lowerBlock(x + c, rowY, eighths, fg, bg)
    }
  }

  if (dimmed) {
    for (let row = 0; row < rows; row += 1) {
      const y0 = y + row
      if (start > 0 && grid.glyphAt(x + start, y0) === " ") grid.setCell(x + start, y0, "▏", edges)
      if (end < width - 1 && grid.glyphAt(x + end, y0) === " ") grid.setCell(x + end, y0, "▕", edges)
    }
  }

  if (input.replay) {
    const marker = Math.max(0, Math.min(width - 1, Math.round(((input.playhead - input.from) / span) * (width - 1))))
    for (let row = 0; row < rows; row += 1) grid.setCell(x + marker, y + row, "│", theme.sky)
  }

  for (let c = 0; c < width; c += 1) grid.hit(x + c, y, 1, rows, `trace:overview:${c}`)
}

/** Ruler: a hairline, the tick labels, the NOW/AT header and the playhead. */
export interface RulerInput {
  readonly layout: TraceLayout
  readonly y: number
  readonly window: TraceWindow
  readonly origin: number
  readonly playhead: number
  readonly replay: boolean
  /** A live run draws the playhead; an ended one leaves the ruler to its ticks. */
  readonly live: boolean
  readonly theme: Palette
}

export function drawRuler(grid: Grid, input: RulerInput): void {
  const { layout, y, window, theme } = input
  for (let c = 0; c < layout.history; c += 1) grid.setCell(layout.x + c, y, "─", theme.border)
  const mark =
    (input.replay || input.live) && input.playhead >= window.a && input.playhead <= window.b
      ? Math.max(0, Math.min(layout.history - 1, Math.round(column(window, layout.history, input.playhead))))
      : undefined
  for (const t of tickMarks(window, layout.history)) {
    const c = Math.round(column(window, layout.history, t))
    if (c < 0 || c > layout.history - 3) continue
    // The playhead owns its column: a label it would run through is dropped, so
    // the ruler never reads `0:1▼`.
    if (mark !== undefined && c <= mark + 1 && c + 5 >= mark - 1) continue
    grid.text(layout.x + c, y, traceClock(t - input.origin), theme.muted)
  }
  for (let c = 0; c < layout.history; c += 1) grid.hit(layout.x + c, y, 1, 1, `trace:ruler:${c}`)

  const head = input.replay ? `AT ${traceClock(input.playhead - input.origin)}` : "NOW"
  grid.text(layout.labelX, y, truncate(head, layout.label), input.replay ? theme.sky : theme.wood, undefined, true)

  if (mark !== undefined) {
    grid.setCell(layout.x + mark, y, "▼", input.replay ? theme.sky : theme.lime, undefined, true)
    if (input.replay) {
      const label = traceClock(input.playhead - input.origin)
      if (mark + 2 + label.length < layout.history) grid.text(layout.x + mark + 2, y, label, theme.sky)
    }
  }
}

/** Faint vertical gridlines on the ticks, so time reads down the whole lens. */
export function drawTickLines(grid: Grid, input: {
  readonly layout: TraceLayout
  readonly window: TraceWindow
  readonly top: number
  readonly height: number
  readonly theme: Palette
}): void {
  for (const t of tickMarks(input.window, input.layout.history)) {
    const c = Math.round(column(input.window, input.layout.history, t))
    if (c < 0 || c >= input.layout.history) continue
    for (let y = input.top; y < input.top + input.height; y += 1) {
      if (grid.glyphAt(input.layout.x + c, y) === " ") grid.setCell(input.layout.x + c, y, "┊", input.theme.border)
    }
  }
}

/** The three row bands a lane height selects: token bars, tool blocks, and the tint span. */
export function laneRows(height: number): { readonly bars: number; readonly block: number; readonly tint: number } {
  if (height >= 4) return { bars: 2, block: 2, tint: 3 }
  if (height === 1) return { bars: 0, block: 0, tint: 1 }
  if (height === 3) return { bars: 1, block: 1, tint: 2 }
  return { bars: 1, block: 1, tint: 2 }
}

/** The file part of a span's target, as a block's label shows it. */
export function shortTarget(span: AgentSpan): string {
  const value = span.file ?? span.target
  const base = value.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? value
  return base === "" ? span.name : base
}

export interface LaneInput {
  readonly row: RosterRow
  readonly spans: readonly AgentSpan[]
  readonly messages: readonly SessionMessageInfo[]
  /** The memoised session, so its token buckets are cached across frames. */
  readonly bucketOwner?: object | undefined
  /** Lane top row in the grid. */
  readonly y: number
  readonly height: number
  readonly layout: TraceLayout
  readonly window: TraceWindow
  readonly theme: Palette
  readonly hue: RGBA
  readonly selected: boolean
  readonly animations: boolean
  readonly tick: number
  /** The playhead. */
  readonly at: number
  /** The live clock, for open spans. */
  readonly now: number
  /** The newest event any lane has; open spans never reach past it. */
  readonly newest?: number | undefined
  readonly live: boolean
  readonly pinned: string | undefined
  /** Live children of a `blocked` row, for its now line. */
  readonly waitingOn: number
  /** The pending ask, when the span list does not carry it. */
  readonly askText?: string | undefined
}

/**
 * One lane: token bars above, tool blocks below, and the now column's one to
 * two lines on the right. The roster draws the same rows from `rowGeometry`, so
 * a lane and its roster row start on the same terminal row.
 */
export function drawLane(grid: Grid, input: LaneInput): void {
  const { row, spans, layout, window, theme, height, y, at } = input
  const ground = theme.background
  const rowBg = input.selected ? theme.surfaceHigh : ground
  const band = laneRows(height)
  const blockY = y + band.block
  const spanMs = Math.max(1, window.b - window.a)
  const width = layout.history
  // An open span only reaches the newest known event; it may breathe out to
  // the clock only when the clock is already inside the window.
  const spanEnd = (span: AgentSpan): number =>
    span.t1 ?? (input.now <= window.b ? input.now : Math.max(span.t0, input.newest ?? input.now))

  if (input.selected) grid.fill(layout.x, y, layout.inner, Math.min(band.tint, height), theme.surfaceHigh)
  grid.hit(layout.x, y, layout.inner, height, `trace:lane:${row.sessionID}`)

  if (band.bars > 0) {
    const buckets = tokenBuckets(spans, input.messages, window.a, window.b, width, input.bucketOwner)
    const peak = buckets.reduce((top, bucket) => Math.max(top, bucket.rate), 0)
    const scale = Math.max(RATE_TOP, peak)
    // Two colours per lane, not one per column: the bar count per column varies.
    const ahead = mix(rowBg, input.hue, 0.25)
    const behind = input.selected ? input.hue : mix(rowBg, input.hue, 0.72)
    for (let c = 0; c < width; c += 1) {
      const rate = buckets[c]?.rate ?? 0
      if (rate <= 0) continue
      const t = window.a + ((c + 0.5) / width) * spanMs
      const color = t > at ? ahead : behind
      let level = Math.round(Math.min(1, rate / scale) * SUB * band.bars)
      for (let step = 0; step < band.bars && level > 0; step += 1) {
        const filled = Math.min(SUB, level)
        grid.lowerBlock(layout.x + c, y + band.bars - 1 - step, filled, color, rowBg)
        level -= filled
      }
    }
  }

  const paint = lanePaint(width * SUB)
  const sub = width * SUB
  for (const span of spans) {
    const tinted = span.kind === "think" || span.kind === "write"
    if (span.kind === "wait" || (tinted && height > 1)) continue
    const end = spanEnd(span)
    if (end < window.a || span.t0 > window.b) continue
    let color: RGBA =
      span.kind === "tool"
        ? span.error === undefined
          ? kindColor(span.letter, theme)
          : theme.error
        : span.kind === "ask"
          ? mix(rowBg, theme.warning, 0.3)
          : span.kind === "retry"
            ? mix(rowBg, theme.warning, 0.16)
            : mix(rowBg, input.hue, 0.22)
    if (!input.selected && span.kind === "tool" && span.error === undefined) color = mix(rowBg, color, 0.8)
    if (span.id === input.pinned) color = mix(color, theme.text, 0.4)
    const faded = mix(rowBg, color, 0.22)
    const start = Math.max(0, Math.round(((Math.max(span.t0, window.a) - window.a) / spanMs) * sub))
    let stop = Math.min(sub, Math.round(((Math.min(end, window.b) - window.a) / spanMs) * sub))
    if (stop <= start) stop = Math.min(sub, start + 1)
    for (let s = start; s < stop; s += 1) {
      const t = window.a + ((s + 0.5) / sub) * spanMs
      paint[s] = t <= at ? color : faded
    }
  }

  for (let c = 0; c < width; c += 1) {
    const offset = c * SUB
    const first = paint[offset]
    let uniform = true
    for (let s = 1; s < SUB; s += 1) {
      if (paint[offset + s] !== first) {
        uniform = false
        break
      }
    }
    if (uniform) {
      if (first !== undefined) grid.setCell(layout.x + c, blockY, " ", theme.text, first)
      continue
    }
    const last = paint[offset + SUB - 1]
    if (first !== last) {
      let eighths = 1
      while (eighths < SUB && paint[offset + eighths] === first) eighths += 1
      grid.leftBlock(layout.x + c, blockY, eighths, first ?? rowBg, last ?? rowBg)
      continue
    }
    let other: RGBA | undefined
    for (let s = 1; s < SUB; s += 1) {
      if (paint[offset + s] !== first) {
        other = paint[offset + s]
        break
      }
    }
    grid.setCell(layout.x + c, blockY, "│", other ?? rowBg, first ?? rowBg)
  }

  const pix = (t: number) => ((t - window.a) / spanMs) * width
  const breath = 0.5 + 0.5 * Math.sin(input.tick * Math.PI * 2)
  for (const span of spans) {
    const end = spanEnd(span)
    if (end < window.a || span.t0 > window.b) continue
    const c0 = Math.ceil(pix(span.t0))
    const c1 = Math.floor(pix(end))
    if (span.kind === "wait") {
      for (let c = Math.max(0, c0); c < Math.min(width, c1); c += 1) {
        if (grid.glyphAt(layout.x + c, blockY) === " ") grid.setCell(layout.x + c, blockY, "╌", theme.wood)
      }
      continue
    }
    if (span.kind === "ask" || span.kind === "retry") {
      const base = span.kind === "ask" ? theme.warning : mix(theme.warning, rowBg, 0.5)
      const color =
        span.kind === "ask" && input.animations && span.t1 === undefined ? mix(base, rowBg, breath * 0.5) : base
      for (let c = Math.max(0, c0); c < Math.min(width, c1); c += 1) {
        grid.setCell(layout.x + c, blockY, span.kind === "ask" ? "▒" : "░", color, rowBg)
      }
      if (c0 >= 0 && c0 < width) {
        grid.setCell(layout.x + c0, blockY, span.kind === "ask" ? "?" : "↻", theme.warning, rowBg, true)
      }
      continue
    }
    if (span.kind !== "tool") continue
    if (c0 >= 0 && c0 < width) {
      grid.hit(layout.x + c0, blockY, Math.max(1, Math.min(width - c0, c1 - c0)), 1, `trace:call:${row.sessionID}:${span.id}`)
    }
    if (c0 < 0 || c0 >= width) continue
    const letter = span.error === undefined ? span.letter : "!"
    const fill = span.error === undefined ? kindColor(span.letter, theme) : theme.error
    grid.setCell(layout.x + c0, blockY, letter, theme.background, undefined, true)
    if (c1 - c0 >= 10) {
      grid.text(layout.x + c0 + 2, blockY, truncate(`${span.name} ${shortTarget(span)}`, c1 - c0 - 2), theme.background)
    }
    if (span.t1 === undefined && input.live && input.animations && c1 > 0 && c1 < width) {
      grid.leftBlock(layout.x + c1, blockY, 2, theme.lime, fill)
    }
  }

  if (row.endedAt !== undefined && row.endedAt >= window.a && row.endedAt <= window.b && row.endedAt <= at) {
    const terminal = row.state === "done" ? "✓" : row.state === "failed" ? "✕" : row.state === "killed" ? "⊘" : ""
    const c = Math.ceil(pix(row.endedAt))
    if (terminal !== "" && c >= 0 && c < width) {
      grid.setCell(layout.x + c, blockY, terminal, row.state === "done" ? theme.done : theme.error, undefined, true)
    }
  }

  // A capped history must never read as a later start: mark the lane's left edge.
  if (row.historyMayBeTruncated && paint[0] === undefined) grid.setCell(layout.x, blockY, "…", theme.faint)

  drawNowColumn(grid, { ...input, rowBg, blockY, at })
}

/** The now column: one to two lines per lane, plus the tool/token summary. */
function drawNowColumn(grid: Grid, input: LaneInput & { readonly rowBg: RGBA; readonly blockY: number }): void {
  const { row, spans, layout, theme, height, blockY, at } = input
  const w = layout.label
  if (w < 6) return
  const x = layout.labelX
  const state = stateAt(row, spans, at)
  const span = spanAt(spans, at)
  const tint = input.rowBg
  const tools = spans.filter((item) => item.kind === "tool" && item.t0 <= at).length
  const summary = `${tools} tool${tools === 1 ? "" : "s"} · ${formatTokens(row.tokens)}`

  if (height >= 3 && w >= 18 && (state === "running" || state === "retry" || state === "waiting" || state === "blocked")) {
    grid.text(x, blockY - 1, truncate(summary, w), theme.faint)
  }

  const write = (parts: readonly { text: string; color: RGBA; bold?: boolean }[]) => {
    let cursor = x
    const end = x + w
    for (const part of parts) {
      if (cursor >= end) break
      cursor = grid.text(cursor, blockY, truncate(part.text, end - cursor), part.color, tint, part.bold ?? false)
    }
    return cursor
  }

  if (state === "idle") {
    write([{ text: "idle", color: theme.faint }])
    return
  }

  if (state === "done" || state === "failed" || state === "killed") {
    const mark = stateGlyph(state, "·")
    const color = state === "done" ? theme.done : theme.error
    const text = nowText(row, spans, at) || (state === "done" ? "finished" : state)
    const wrapped = height >= 3 && w >= 10 ? wrapTwo(text, w - 2) : undefined
    if (wrapped !== undefined) {
      grid.setCell(x, blockY - 1, mark, color, tint, true)
      grid.text(x + 2, blockY - 1, truncate(wrapped[0], w - 2), state === "done" ? theme.faint : color, tint)
      grid.text(x + 2, blockY, truncate(wrapped[1], w - 2), state === "done" ? theme.faint : color, tint)
    } else {
      write([
        { text: `${mark} `, color, bold: true },
        { text, color: state === "done" ? theme.muted : color },
      ])
    }
    return
  }

  if (state === "waiting") {
    const ask = span?.kind === "ask" ? span.target : (input.askText ?? "")
    write([
      { text: `${stateGlyph("waiting", "·")} `, color: theme.warning, bold: true },
      { text: ask === "" ? "needs you" : ask, color: theme.warning },
    ])
    return
  }

  if (state === "retry") {
    const detail = span?.kind === "retry" ? span.target || span.error || "retrying" : "retrying"
    write([
      { text: `${stateGlyph("retry", "·")} `, color: theme.warning, bold: true },
      { text: detail, color: theme.warning },
    ])
    return
  }

  if (state === "blocked") {
    const count = input.waitingOn
    write([
      {
        text: count > 0 ? `waiting on ${count} branch${count === 1 ? "" : "es"}` : "waiting on branches",
        color: theme.wood,
      },
    ])
    return
  }

  if (span === undefined) return
  if (span.kind === "tool") {
    const color = span.error === undefined ? kindColor(span.letter, theme) : theme.error
    const elapsed = durationText((span.t1 ?? input.now) - span.t0)
    const room = Math.max(1, w - elapsed.length - 1)
    let cursor = write([{ text: `${span.name} `, color, bold: true }])
    cursor = grid.text(cursor, blockY, truncate(shortTarget(span), Math.max(0, room - (cursor - x))), theme.text, tint)
    if (cursor < x + w - elapsed.length) grid.right(x + w, blockY, elapsed, theme.faint, tint)
    return
  }
  if (span.kind === "think") {
    shimmer(grid, x, blockY, "thinking", w, input, tint)
    return
  }
  write([{ text: span.kind === "write" ? "writing" : span.name, color: theme.muted }])
}

/** The thinking shimmer: a gaussian highlight travelling across the word. */
function shimmer(grid: Grid, x: number, y: number, text: string, width: number, input: LaneInput, tint: RGBA): void {
  const centre = input.animations ? ((input.tick * 11) % (text.length + 8)) - 4 : -99
  for (let index = 0; index < text.length && index < width; index += 1) {
    const distance = index - centre
    const glow = Math.exp(-(distance * distance) / (2 * 1.8 * 1.8))
    grid.setCell(x + index, y, text[index]!, mix(input.theme.faint, input.theme.text, glow), tint)
  }
}

/** Greedy two-line wrap; undefined when the text already fits. */
export function wrapTwo(text: string, width: number): [string, string] | undefined {
  if (width <= 0 || text.length <= width) return undefined
  const words = text.split(/\s+/).filter((word) => word !== "")
  let head = ""
  let index = 0
  while (index < words.length) {
    const next = head === "" ? words[index]! : `${head} ${words[index]!}`
    if (next.length > width) break
    head = next
    index += 1
  }
  if (head === "" || index === words.length) return undefined
  return [head, words.slice(index).join(" ")]
}

export interface LinkInput {
  readonly layout: TraceLayout
  readonly window: TraceWindow
  readonly theme: Palette
  readonly player: ReadonlyArray<{ readonly row: RosterRow; readonly top: number; readonly block: number }>
  readonly selected: string | undefined
}

/** Spawn links: a vertical drop from the parent lane to the child at spawn time. */
export function drawSpawnLinks(grid: Grid, input: LinkInput): void {
  const byID = new Map(input.player.map((entry) => [entry.row.sessionID, entry]))
  for (const child of input.player) {
    const parentID = child.row.parentID
    if (parentID === undefined) continue
    const parent = byID.get(parentID)
    if (parent === undefined) continue
    const c = Math.round(column(input.window, input.layout.history, child.row.startedAt))
    if (c < 0 || c >= input.layout.history) continue
    const color = child.row.sessionID === input.selected ? input.theme.leaf : input.theme.wood
    for (let y = parent.block + 1; y < child.block; y += 1) {
      if (grid.glyphAt(input.layout.x + c, y) === " ") grid.setCell(input.layout.x + c, y, "│", color)
    }
    if (grid.glyphAt(input.layout.x + c, child.block) === " ") grid.setCell(input.layout.x + c, child.block, "╰", color)
  }
}

export interface NowLineInput {
  readonly layout: TraceLayout
  readonly window: TraceWindow
  readonly top: number
  readonly height: number
  readonly playhead: number
  readonly replay: boolean
  /** Only a live run carries a now line; an ended one has no playhead. */
  readonly live: boolean
  readonly theme: Palette
}

/** The vertical now line (or the replay playhead) down every lane. */
export function drawNowLine(grid: Grid, input: NowLineInput): void {
  if (!input.replay && !input.live) return
  if (input.playhead < input.window.a || input.playhead > input.window.b) return
  const c = Math.max(0, Math.min(input.layout.history - 1, Math.round(column(input.window, input.layout.history, input.playhead))))
  const color = input.replay ? input.theme.sky : mix(input.theme.wood, input.theme.lime, 0.55)
  for (let y = input.top; y < input.top + input.height; y += 1) {
    const glyph = grid.glyphAt(input.layout.x + c, y)
    if (glyph === undefined) continue
    const blank = glyph === " " || glyph === "┊" || glyph === "│"
    if (blank) grid.setCell(input.layout.x + c, y, "│", color)
    else {
      const cell = grid.cell(input.layout.x + c, y)!
      grid.setCell(input.layout.x + c, y, glyph, cell.fg, mix(cell.bg, color, 0.25))
    }
  }
}

export interface LegendInput {
  readonly layout: TraceLayout
  readonly y: number
  readonly theme: Palette
  readonly zoomed: boolean
}

const LEGEND: ReadonlyArray<readonly [ToolLetter, string]> = [
  ["R", "read"],
  ["S", "search"],
  ["E", "edit"],
  ["$", "shell"],
  ["V", "verify"],
  ["W", "web"],
]

/** `R read  S search  …` on the left, the zoom hint on the right. */
export function drawLegend(grid: Grid, input: LegendInput): void {
  const { layout, y, theme } = input
  let cursor = layout.x
  if (layout.inner >= 64) {
    for (const [letter, label] of LEGEND) {
      grid.setCell(cursor, y, letter, theme.background, kindColor(letter, theme), true)
      cursor = grid.text(cursor + 2, y, label, theme.faint)
      cursor += 2
    }
  }
  // Zoom is a drag on the overview; the only visible control is the way back,
  // and it is drawn only while a zoom is active. No key hint occupies the row.
  if (!input.zoomed) return
  const hint = "reset zoom"
  if (cursor - layout.x + hint.length + 2 >= layout.inner) return
  const start = layout.x + layout.inner - hint.length
  grid.text(start, y, hint, theme.faint)
  grid.hit(start, y, hint.length, 1, "trace:reset-zoom")
}

export interface EmptyInput {
  readonly layout: TraceLayout
  readonly top: number
  readonly height: number
  readonly theme: Palette
}

/** The bare-run copy: where lanes will appear, and how to make them. */
export function drawEmpty(grid: Grid, input: EmptyInput): void {
  const lines: ReadonlyArray<readonly [string, RGBA, boolean]> = [
    ["", input.theme.text, false],
    ["No branches yet", input.theme.text, true],
    ["", input.theme.text, false],
    ["Agents appear here as lanes when build fans out.", input.theme.muted, false],
    ["Press Tab and send a message to try it.", input.theme.muted, false],
  ]
  const centre = input.top + Math.floor(input.height / 2) - 2
  lines.forEach(([text, color, bold], index) => {
    if (text === "") return
    const x = input.layout.x + Math.floor((input.layout.inner - text.length) / 2)
    grid.text(x, centre + index, text, color, undefined, bold)
  })
}
