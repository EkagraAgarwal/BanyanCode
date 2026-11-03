import type { RGBA } from "@opentui/core"
import { formatTokens, truncate } from "../../data/format"
import { shortLabel, stateGlyph, type RosterRow } from "../../data/understory"
import { gauss, mix } from "../../motion"
import type { Palette } from "../../theme"
import { sproutFrame } from "../status/sprout"
import { CellGrid, type Grid } from "./cells"
import { costText, rosterWindow, runClock, stateColor, stateCountSpans, treePrefix } from "./layout"

/** The running frame, else the state's glyph. */
export function rowGlyph(row: RosterRow, index: number, tick: number, animations: boolean): string {
  if (row.state !== "running") return stateGlyph(row.state, "⋯")
  return animations ? sproutFrame(tick, index) : "⋯"
}

/** A waiting agent breathes; every other state has one flat colour. */
export function rowColor(row: RosterRow, theme: Palette, tick: number, animations: boolean): RGBA {
  if (row.state === "waiting" && animations) {
    const breath = 0.5 + 0.5 * Math.sin(tick * Math.PI * 2)
    return mix(theme.warning, theme.border, breath * 0.6)
  }
  return stateColor(row.state, theme)
}

/**
 * The tint behind the selected roster row. Exported so a lens can mark the same
 * row with the same background instead of inventing a second highlight.
 */
export function selectionBackground(theme: Palette): RGBA {
  return theme.surfaceHigh
}

/** One step of a sparkline; index 0 is blank so a quiet column costs no glyph. */
const SPARK_GLYPH = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

const sparkGlyph = (value: number): string =>
  SPARK_GLYPH[Math.max(0, Math.min(SPARK_GLYPH.length - 1, Math.round(value)))]!

/** What the roster header reports about the whole run. */
export interface RosterSummary {
  readonly clock: string
  readonly state: string
  readonly stateColor: RGBA
  readonly tokens: number
  /** Live tokens per second; absent when there is no real signal. */
  readonly rate?: number | undefined
  readonly cost: number
  /** The branch limit from the mesh, when it has loaded. */
  readonly limit?: number | undefined
}

export interface RosterProps {
  readonly rows: readonly RosterRow[]
  /** Rows after folding. */
  readonly visible: readonly RosterRow[]
  readonly hidden: number
  readonly folded: boolean
  readonly selected: string | undefined
  readonly hues: ReadonlyMap<string, RGBA>
  readonly theme: Palette
  readonly width: number
  /** The whole panel height, including the status row under the roster. */
  readonly height: number
  readonly animations: boolean
  /** True while the run is live; only then does the trunk pulse. */
  readonly live: boolean
  readonly tick: number
  readonly now: () => number
  readonly summary: RosterSummary
  /** Sparkline steps for one row, oldest first; empty when no tokens streamed. */
  readonly spark: (row: RosterRow) => readonly number[]
  readonly offset: number
  /** Header rows the roster shares with the lens; the row list starts here. */
  readonly header: number
  /** Rows each lane takes; the roster draws exactly this many per agent. */
  readonly laneHeight: number
  readonly onSelect: (sessionID: string) => void
  /** Wheel steps in rows, so the roster and the lanes scroll together. */
  readonly onScroll: (delta: number) => void
}

/**
 * The trunk tree. Its header lines sit in the same rows as the lens tabs,
 * overview and ruler, and each agent draws exactly `laneHeight` rows, so a
 * roster row and its lane read across.
 */
export function Roster(props: RosterProps) {
  const hueOf = (sessionID: string): RGBA => props.hues.get(sessionID) ?? props.theme.leaf

  // A prefix segment is two columns: a rail column and a connector column.
  const topOf = (segment: string): string => (segment === "├─" ? "├╴" : segment === "╰─" ? "╰╴" : segment)
  const downOf = (segment: string): string =>
    segment === "├─" ? "│ " : segment === "╰─" ? "  " : segment

  const draw = (grid: Grid) => {
    const width = Math.max(1, props.width)
    const theme = props.theme
    const list = props.visible
    const lane = Math.max(1, props.laneHeight)
    const header = Math.min(Math.max(0, props.header), Math.max(0, props.height - 1))
    const area = Math.max(0, props.height - 1 - header)
    const big = width >= 28
    const reserveFold = props.folded && props.hidden > 0 ? 1 : 0
    const rowArea = Math.max(0, area - reserveFold)
    const selectedIndex = list.findIndex((row) => row.sessionID === props.selected)
    const window = rosterWindow({
      total: list.length,
      areaRows: rowArea,
      rowHeight: lane,
      offset: props.offset,
      ...(selectedIndex < 0 ? {} : { selected: selectedIndex }),
    })

    // --- header: the same rows as the lens tabs, overview and ruler ---------
    const branches = props.rows.reduce((count, row) => (row.depth > 0 ? count + 1 : count), 0)
    const title = grid.text(1, 0, big ? "BRANCHES" : "BRCH", theme.wood, undefined, true)
    if (width >= 18) {
      const label =
        big && props.summary.limit !== undefined ? `${branches}/${props.summary.limit}` : String(branches)
      grid.text(title + 1, 0, label, theme.muted)
    }
    if (header >= 3 && width >= 18) {
      let cursor = grid.text(1, 1, "RUN ", theme.faint)
      cursor = grid.text(cursor, 1, props.summary.clock, theme.text, undefined, true)
      if (big) grid.text(cursor + 2, 1, props.summary.state, props.summary.stateColor)
      let x = 1
      if (props.summary.tokens > 0) {
        x = grid.text(x, 2, formatTokens(props.summary.tokens), theme.text)
        x = grid.text(x + 1, 2, "tok", theme.muted)
      }
      if (props.summary.rate !== undefined) {
        const start = x === 1 ? 1 : x + 2
        const end = grid.text(start, 2, `${Math.round(props.summary.rate)}`, theme.text)
        grid.text(end + 1, 2, "t/s", theme.muted)
      }
      const cost = costText(props.summary.cost)
      if (cost !== "") grid.right(width - 1, 2, cost, theme.muted)
      if (header >= 5) {
        let chipX = 1
        for (const span of stateCountSpans(width - 2, props.rows, theme)) {
          chipX = grid.text(chipX, 3, span.text, span.color, undefined, span.bold === true)
        }
      }
    }

    // --- agents: one lane each, tree order, never reordered -----------------
    const pulse = props.live && props.animations
    const pulseY = header + ((props.tick * 9) % (area + 6))
    const rail = (y: number): RGBA =>
      pulse ? mix(theme.wood, theme.lime, gauss(y - pulseY, 2.4) * 0.85) : theme.wood
    const drawn = list.slice(window.offset, window.offset + window.count)

    drawn.forEach((row, index) => {
      const absolute = window.offset + index
      const y = header + index * lane
      if (y >= header + area) return
      const selected = row.sessionID === props.selected
      const selection = selectionBackground(theme)
      const rowBg = selected ? selection : undefined
      const textLines = lane >= 3 ? lane - 1 : lane
      if (selected) {
        grid.fill(0, y, width, textLines, selection)
        grid.setCell(0, y, "▌", theme.leaf, selection)
      }

      const prefix = treePrefix(list, row)
      const chars = [...prefix.text]
      const segments = chars.flatMap((char, position) =>
        position % 2 === 0 ? [`${char}${chars[position + 1] ?? " "}`] : [],
      )
      const shown = segments.slice(-(big ? 3 : 1))
      const gx = 1 + shown.length * 2
      shown.forEach((segment, level) => {
        const column = 1 + level * 2
        grid.text(column, y, topOf(segment), rail(y), rowBg)
        for (let row_ = 1; row_ < lane; row_ += 1) {
          if (y + row_ >= header + area) break
          grid.text(column, y + row_, downOf(segment), rail(y + row_), row_ < textLines ? rowBg : undefined)
        }
      })

      const glyph = rowGlyph(row, absolute, props.tick, props.animations)
      grid.setCell(gx, y, glyph, rowColor(row, theme, props.tick, props.animations), rowBg, true)
      const nameX = gx + 2
      const xEnd = width - 1
      const nameColor =
        row.depth === 0
          ? theme.text
          : row.state === "done"
            ? mix(hueOf(row.sessionID), theme.muted, 0.55)
            : hueOf(row.sessionID)
      const task = row.title === undefined ? "" : row.title

      if (lane === 1) {
        const tokens = big && row.tokens > 0 ? formatTokens(row.tokens) : ""
        const nameWidth = Math.max(1, xEnd - nameX + 1 - (tokens === "" ? 0 : tokens.length + 1))
        const nameEnd = grid.text(nameX, y, shortLabel(row.label, big ? Math.min(14, nameWidth) : nameWidth), nameColor, rowBg, true)
        if (big) {
          if (task !== "") {
            const room = xEnd - nameEnd - (tokens === "" ? 0 : tokens.length + 1) - 1
            if (room > 2) grid.text(nameEnd + 1, y, truncate(task, room), theme.muted, rowBg)
          }
          if (tokens !== "") grid.right(xEnd, y, tokens, theme.faint, rowBg)
        }
        grid.hit(0, y, width, 1, `row:${row.sessionID}`)
        return
      }

      const elapsed = big ? runClock((row.endedAt ?? props.now()) - row.startedAt) : ""
      const nameWidth = Math.max(1, xEnd - nameX + 1 - (big ? elapsed.length + 2 : 0))
      const label = shortLabel(row.label, nameWidth)
      grid.text(nameX, y, label, nameColor, rowBg, true)
      if (big) grid.right(xEnd, y, elapsed, row.state === "done" ? theme.faint : theme.muted, rowBg)

      const values = props.spark(row)
      if (big && lane === 3 && values.length > 0 && (row.state === "running" || row.state === "retry")) {
        const room = Math.max(0, Math.min(8, xEnd - elapsed.length - nameX - label.length - 2))
        if (room > 2) {
          const slice = values.slice(-room)
          grid.text(xEnd - elapsed.length - slice.length - 1, y, slice.map(sparkGlyph).join(""), nameColor, rowBg)
        }
      }

      if (textLines >= 2 && task !== "") {
        grid.text(
          nameX,
          y + 1,
          truncate(task, Math.max(0, xEnd - nameX + 1)),
          row.state === "done" ? theme.faint : theme.muted,
          rowBg,
        )
      }

      if (big && textLines >= 3) {
        const total = row.tokens > 0 ? formatTokens(row.tokens) : ""
        const cost = costText(row.cost)
        let cursor = grid.text(nameX, y + 2, total, theme.muted, rowBg)
        if (total !== "" && values.length > 0 && (row.state === "running" || row.state === "retry")) {
          const room = Math.max(0, Math.min(14, xEnd - (cost === "" ? 0 : cost.length + 1) - cursor - 1))
          if (room > 2) {
            const slice = values.slice(-room)
            cursor = grid.text(cursor + 1, y + 2, slice.map(sparkGlyph).join(""), nameColor, rowBg)
          }
        }
        if (cost !== "") grid.right(xEnd, y + 2, cost, theme.faint, rowBg)
      }

      grid.hit(0, y, width, lane, `row:${row.sessionID}`)
    })

    // --- the reserved rows under the list -----------------------------------
    const below = header + window.count * lane
    if (props.folded && props.hidden > 0) {
      const foldY = Math.min(below, header + area - 1)
      if (foldY >= header) {
        grid.text(1, foldY, `✓ ${props.hidden} done`, theme.done)
        grid.right(width - 1, foldY, "z show", theme.faint)
      }
    }
    if (window.overflow) {
      grid.text(1, Math.min(below, header + area), `↓ ${window.more} more`, theme.faint)
    }
  }

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} minHeight={0} overflow="hidden">
      <CellGrid
        id="banyancode.understory.roster"
        width={props.width}
        height={Math.max(1, props.height - 1)}
        background={props.theme.background}
        draw={draw}
        onHit={(region) => {
          if (region.startsWith("row:")) props.onSelect(region.slice("row:".length))
        }}
        onScroll={(direction, delta) => {
          if (direction === "left" || direction === "right") return
          const steps = Math.max(1, delta)
          props.onScroll(direction === "down" ? steps : -steps)
        }}
      />
    </box>
  )
}
