import type { RGBA } from "@opentui/core"
import type { Palette } from "../../theme"
import { truncate } from "../../data/format"
import { stateGlyph, type RosterRow, type UnderstoryState } from "../../data/understory"

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

/** Rows per roster entry: three while they all fit, otherwise one. */
export function rosterRowHeight(entryCount: number, areaRows: number): number {
  if (entryCount <= 0 || areaRows <= 0) return 3
  return entryCount * 3 <= areaRows ? 3 : 1
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

/** `mm:ss` for the stream's time column. */
export function streamClock(ms: number): string {
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
 * The roster header's per-state chips, tightest first: waiting and the
 * terminal failures outrank the running count, and done is dropped before
 * anything else. A chip is only drawn whole, so a narrow roster never shows a
 * clipped number.
 */
export function stateCountSpans(width: number, rows: readonly RosterRow[], theme: Palette): Span[] {
  const order: readonly UnderstoryState[] = ["waiting", "failed", "killed", "running", "retry", "blocked", "idle", "done"]
  const counts = new Map<UnderstoryState, number>()
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
  let used = 0
  return order.flatMap((state): Span[] => {
    const count = counts.get(state) ?? 0
    if (count === 0) return []
    const glyph = stateGlyph(state, "⋯")
    const separator = used === 0 ? 0 : 1
    if (used + separator + glyph.length + String(count).length > width) return []
    used += separator + glyph.length + String(count).length
    return [
      ...(separator === 0 ? [] : [{ text: " ", color: theme.faint }]),
      { text: glyph, color: stateColor(state, theme) },
      { text: String(count), color: theme.muted },
    ]
  })
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

/** Rows left for the roster list after the panel hint and the roster header. */
export function rosterAreaRows(panelHeight: number): number {
  return Math.max(0, Math.floor(panelHeight) - 1 - ROSTER_HEADER_ROWS)
}

export function streamAreaRows(panelHeight: number): number {
  return Math.max(0, Math.floor(panelHeight) - 2)
}
