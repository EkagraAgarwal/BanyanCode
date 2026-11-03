import type { RGBA } from "@opentui/core"
import type { Palette } from "../../theme"
import { truncate } from "../../data/format"
import { isLiveState, type RosterRow, type UnderstoryState } from "../../data/understory"

/** Column widths from the design brief. The inspector docks only at the widest tier. */
export const ROSTER_WIDE = 34
export const ROSTER_MEDIUM = 28
export const ROSTER_NARROW = 18
export const ROSTER_TINY = 12
export const INSPECTOR_WIDTH = 44
export const WIDE_LAYOUT = 150
/** Two rows: `RUN` with the clock, then the per-state counts. */
export const ROSTER_HEADER_ROWS = 2

export interface UnderstoryColumns {
  readonly roster: number
  readonly stream: number
  /** True when the inspector is docked; false means it is an overlay. */
  readonly docked: boolean
}

export function understoryColumns(width: number): UnderstoryColumns {
  const total = Math.max(0, Math.floor(width))
  const roster =
    total >= WIDE_LAYOUT
      ? ROSTER_WIDE
      : total >= 110
        ? ROSTER_MEDIUM
        : total >= 84
          ? ROSTER_NARROW
          : ROSTER_TINY
  const docked = total >= WIDE_LAYOUT
  const inspector = docked ? INSPECTOR_WIDTH : 0
  return { roster: Math.min(roster, total), stream: Math.max(0, total - roster - inspector), docked }
}

/**
 * Rows per roster entry: three while they all fit, otherwise one. The lens's
 * lane height wins when it is known, so a roster row and its lane start on the
 * same row; the roster pads the difference until it draws every lane row.
 */
export function rosterRowHeight(entryCount: number, areaRows: number, laneHeight?: number): number {
  const base = entryCount <= 0 || areaRows <= 0 ? 3 : entryCount * 3 <= areaRows ? 3 : 1
  if (laneHeight === undefined) return base
  return Math.max(1, Math.min(4, laneHeight))
}

// ---------------------------------------------------------------------------
// Row geometry: one header height and one lane height, so the roster rows and
// the lens lanes land on the same terminal rows.
// ---------------------------------------------------------------------------

/** Height on the rows>=36 tier: three rows of token-rate layers. */
export const OVERVIEW_ROWS_TALL = 3
/** Height on the rows>=28 tier: two rows of token-rate layers. */
export const OVERVIEW_ROWS_MEDIUM = 2
/** 4 rows of token bars, 3 rows of tool blocks, 2 rows, then blocks only. */
export const LANE_HEIGHTS = [4, 3, 2, 1] as const

export function overviewRows(rows: number): number {
  if (rows >= 36) return OVERVIEW_ROWS_TALL
  if (rows >= 28) return OVERVIEW_ROWS_MEDIUM
  return 0
}

/** Lens tabs, the overview strip, then the ruler. Lanes start below. */
export function headerRows(rows: number): number {
  return 1 + overviewRows(rows) + 1
}

export interface RowGeometry {
  readonly rows: number
  /** Lens tab row: always one. */
  readonly tabs: number
  /** Overview strip rows: 3, 2 or 0. */
  readonly overview: number
  /** Time ruler rows: always one. */
  readonly ruler: number
  /** Rows above the first lane, and the rows the roster header shares. */
  readonly header: number
  /** The largest lane height that fits, 4 down to 1. */
  readonly laneHeight: number
  /** Rows left for lanes after the header and the hint row. */
  readonly lanesArea: number
  /** Lanes that fit; smaller than `agents` means the panel scrolls. */
  readonly visibleLanes: number
  readonly overflow: boolean
}

/**
 * The single row map for the Agents tab. `rows` is the panel height, so the
 * hint row is reserved here, and both the roster and the active lens read the
 * same header and lane height from this.
 */
export function rowGeometry(rows: number, agents: number): RowGeometry {
  const total = Math.max(0, Math.floor(rows))
  const count = Math.max(0, Math.floor(agents))
  const overview = overviewRows(total)
  const header = 1 + overview + 1
  const lanesArea = Math.max(0, total - 1 - header)
  const laneHeight = LANE_HEIGHTS.find((height) => count * height <= lanesArea) ?? 1
  const visibleLanes = Math.min(count, Math.floor(lanesArea / laneHeight))
  return {
    rows: total,
    tabs: 1,
    overview,
    ruler: 1,
    header,
    laneHeight,
    lanesArea,
    visibleLanes,
    overflow: visibleLanes < count,
  }
}

// ---------------------------------------------------------------------------
// Trace time window
// ---------------------------------------------------------------------------

/** A fixed 0.7 s per column keeps a normal tool call at least two cells wide. */
export const TRACE_SECONDS_PER_COLUMN = 0.7
export const TRACE_SCALE_MIN = 0.1
export const TRACE_SCALE_MAX = 4
/** Live paging: forward 30% of the window when the now line reaches 90%. */
export const PAGE_FRACTION = 0.3
export const PAGE_TRIGGER = 0.9

export interface TraceWindow {
  readonly a: number
  readonly b: number
  /** Seconds per column for this window. */
  readonly scale: number
}

export interface TraceWindowInput {
  /** Run start; the window never shows earlier. */
  readonly start: number
  /** Set once the run stopped; omitted while it is live. */
  readonly end?: number | undefined
  /** The playhead the window must contain. */
  readonly now: number
  readonly columns: number
  /** Seconds per column; `TRACE_SECONDS_PER_COLUMN` unless zoomed. */
  readonly scale?: number | undefined
  /** Start of the current page, from the previous call. */
  readonly anchor?: number | undefined
}

/**
 * The visible time window. While live the column scale is fixed and the window
 * pages forward in 30% steps, so history stays still between pages. Once the
 * run ends the whole run is fitted to the column count.
 */
export function traceWindow(input: TraceWindowInput): TraceWindow {
  const columns = Math.max(1, Math.floor(input.columns))
  if (input.end !== undefined) {
    const span = Math.max(1, input.end - input.start)
    return { a: input.start, b: input.start + span, scale: span / columns }
  }
  const scale = input.scale ?? TRACE_SECONDS_PER_COLUMN
  const span = columns * scale
  const from = Math.max(input.start, input.anchor ?? input.start)
  const lead = span * PAGE_TRIGGER
  const step = span * PAGE_FRACTION
  const pages = input.now > from + lead ? Math.ceil((input.now - from - lead) / step) : 0
  const a = from + pages * step
  return { a, b: a + span, scale }
}

/** `+` halves the seconds per column (zoom in); `-` doubles it. */
export function zoomScale(scale: number, direction: 1 | -1): number {
  const next = direction === 1 ? scale / 2 : scale * 2
  return Math.max(TRACE_SCALE_MIN, Math.min(TRACE_SCALE_MAX, next))
}

/** A time's column inside the window, unclipped. */
export function columnAt(window: TraceWindow, columns: number, t: number): number {
  return ((t - window.a) / (window.b - window.a)) * Math.max(1, columns)
}


export interface RosterWindow {
  /** Index of the first drawn row. */
  readonly offset: number
  /** Number of entry rows drawn. */
  readonly count: number
  /** True when a `↓ N more` marker takes the last row. */
  readonly overflow: boolean
  /** The marker's count: rows not drawn because they are below the window. */
  readonly more: number
}

/**
 * Fit as many roster entries as the area holds. When they cannot all fit, one
 * row is reserved for the `↓ N more` marker, so the marker never replaces the
 * selected row.
 */
export function rosterWindow(input: {
  readonly total: number
  readonly areaRows: number
  readonly rowHeight: number
  readonly offset: number
  readonly selected?: number | undefined
}): RosterWindow {
  const area = Math.max(0, Math.floor(input.areaRows))
  const height = Math.max(1, input.rowHeight)
  const fits = Math.floor(area / height)
  const overflow = input.total * height > area
  const count = Math.max(0, Math.min(input.total, overflow ? Math.floor(Math.max(0, area - 1) / height) : fits))
  const maxOffset = Math.max(0, input.total - count)
  const wanted = Math.max(0, Math.min(maxOffset, input.offset))
  const selected = input.selected
  const offset =
    selected === undefined
      ? wanted
      : Math.max(0, Math.min(maxOffset, selected < wanted ? selected : selected >= wanted + count ? selected - count + 1 : wanted))
  const shown = Math.max(0, Math.min(count, input.total - offset))
  return { offset, count: shown, overflow: overflow && shown < input.total, more: Math.max(0, input.total - offset - shown) }
}

/** `1m 04s`, matching the host's compact duration format without a leading zero. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** `0:46`, the run clock the lens tabs carry. */
export function runClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** `mm:ss` for the stream's time column. */export function streamClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export function stateLabel(state: UnderstoryState): string {
  if (state === "waiting") return "NEEDS YOU"
  if (state === "blocked") return "WAITING"
  if (state === "retry") return "RETRYING"
  if (state === "done") return "FINISHED"
  if (state === "failed") return "FAILED"
  if (state === "killed") return "KILLED"
  if (state === "running") return "RUNNING"
  return "IDLE"
}

export function stateColor(state: UnderstoryState, theme: Palette): RGBA {
  if (state === "waiting" || state === "retry") return theme.warning
  if (state === "failed" || state === "killed") return theme.error
  if (state === "running") return theme.leaf
  if (state === "blocked") return theme.wood
  if (state === "done") return theme.done
  return theme.faint
}

export function countStates(rows: readonly RosterRow[]): ReadonlyArray<{ state: UnderstoryState; count: number }> {
  const order: readonly UnderstoryState[] = ["running", "retry", "waiting", "blocked", "done", "failed", "killed", "idle"]
  return order.flatMap((state) => {
    const count = rows.filter((row) => row.state === state).length
    return count === 0 ? [] : [{ state, count }]
  })
}

/**
 * The roster header's per-state chips, in the mockup's order and glyphs:
 * `⣿ running ▲ waiting ✕ failed ✓ done`. The root is not a branch, so it is
 * not counted. A chip is only drawn whole, so a narrow roster never shows a
 * clipped number.
 */
export function stateCountSpans(width: number, rows: readonly RosterRow[], theme: Palette): Span[] {
  const counts = { running: 0, waiting: 0, failed: 0, done: 0 }
  for (const row of rows) {
    if (row.depth === 0) continue
    if (row.state === "running" || row.state === "retry" || row.state === "blocked") counts.running += 1
    else if (row.state === "waiting") counts.waiting += 1
    else if (row.state === "failed" || row.state === "killed") counts.failed += 1
    else if (row.state === "done") counts.done += 1
  }
  const chips: ReadonlyArray<{ glyph: string; count: number; color: RGBA }> = [
    { glyph: "⣿", count: counts.running, color: theme.leaf },
    { glyph: "▲", count: counts.waiting, color: theme.warning },
    { glyph: "✕", count: counts.failed, color: theme.error },
    { glyph: "✓", count: counts.done, color: theme.done },
  ]
  let used = 0
  return chips.flatMap((chip): Span[] => {
    if (chip.count === 0) return []
    const separator = used === 0 ? 0 : 1
    const text = `${chip.glyph}${chip.count}`
    if (used + separator + [...text].length > width) return []
    used += separator + [...text].length
    return [
      ...(separator === 0 ? [] : [{ text: " ", color: theme.faint }]),
      { text: chip.glyph, color: chip.color },
      { text: String(chip.count), color: theme.muted },
    ]
  })
}

/** What the run header says after the clock. */
export function runStateLabel(rows: readonly RosterRow[]): string {
  const root = rows.find((row) => row.depth === 0)
  if (root === undefined) return "idle"
  if (root.endedAt !== undefined) return "finished"
  if (rows.some((row) => isLiveState(row.state))) return "running"
  return "idle"
}

export function runStateColor(rows: readonly RosterRow[], theme: Palette): RGBA {
  const label = runStateLabel(rows)
  if (label === "running") return theme.leaf
  return theme.muted
}

/** Two columns per level, up to three levels; deeper levels show the depth digit. */
export interface TreePrefix {
  readonly text: string
  /** True when the prefix is the depth digit rather than a real connector. */
  readonly depthOnly: boolean
}

const siblingLast = (rows: readonly RosterRow[], row: RosterRow): boolean => {
  if (row.parentID === undefined) return true
  const siblings = rows.filter((item) => item.parentID === row.parentID)
  return siblings[siblings.length - 1]?.sessionID === row.sessionID
}

export function treePrefix(rows: readonly RosterRow[], row: RosterRow): TreePrefix {
  if (row.depth === 0) return { text: "", depthOnly: false }
  if (row.depth > 3) return { text: `${Math.min(9, row.depth)} `, depthOnly: true }
  const byID = new Map(rows.map((item) => [item.sessionID, item]))
  const segments: string[] = []
  let current: RosterRow | undefined = row
  let level = row.depth
  while (current !== undefined && level > 0) {
    if (level === row.depth) segments.unshift(siblingLast(rows, current) ? "╰─" : "├─")
    else segments.unshift(siblingLast(rows, current) ? "  " : "│ ")
    current = current.parentID === undefined ? undefined : byID.get(current.parentID)
    level -= 1
  }
  return { text: segments.join(""), depthOnly: false }
}

/** The priced cost, hidden at exactly zero (subscription plans). */
export function costText(cost: number): string {
  if (cost <= 0) return ""
  return `$${cost.toFixed(2)}`
}

/** A line built from coloured spans. Every span is clipped so the total never exceeds `width`. */
export interface Span {
  readonly text: string
  readonly color: RGBA
  readonly bold?: boolean
}

export function spans(width: number, parts: readonly Span[]): Span[] {
  let left = Math.max(0, width)
  return parts.flatMap((part) => {
    if (left <= 0) return []
    const text = truncate(part.text, left)
    left -= text.length
    return text === "" ? [] : [{ ...part, text }]
  })
}

export function pad(width: number, value: string): string {
  return value.length >= width ? truncate(value, width) : value + " ".repeat(width - value.length)
}

export function rightAlign(inner: number, left: string, right: string): string {
  if (right === "") return truncate(left, inner)
  const gap = inner - left.length - right.length
  if (gap < 1) return truncate(`${left} ${right}`, inner)
  return `${left}${" ".repeat(gap)}${right}`
}

/**
 * Add hint segments in priority order until the line is full. The result is
 * never wider than `width`, so the hints row never wraps.
 */
export function fitHints(width: number, segments: readonly string[]): string {
  if (width <= 0) return ""
  const available = Math.max(0, width)
  let line = ""
  for (const segment of segments) {
    const next = line === "" ? segment : `${line} · ${segment}`
    if (next.length > available) continue
    line = next
  }
  if (line === "" && segments[0] !== undefined) return truncate(segments[0], available)
  return line
}

/** Rows left for the roster list after the panel hint and the shared header rows. */
export function rosterAreaRows(panelHeight: number): number {
  const height = Math.max(0, Math.floor(panelHeight))
  return Math.max(0, height - 1 - headerRows(height))
}

export function streamAreaRows(panelHeight: number): number {
  return Math.max(0, Math.floor(panelHeight) - 2)
}
