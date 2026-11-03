/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { isLiveState } from "../../../data/understory"
import { messagesAt, tokenBuckets } from "../../../data/understory-spans"
import { CellGrid, type Grid, type GridPointer } from "../cells"
import { rosterWindow, TRACE_SECONDS_PER_COLUMN } from "../layout"
import type { LensProps } from "../view"
import {
  drawEmpty,
  drawLane,
  drawLegend,
  drawNowLine,
  drawOverview,
  drawRuler,
  drawSpawnLinks,
  drawTickLines,
  laneRows,
  traceLayout,
} from "./draw"

/** A double click inside the overview resets the zoom, like the mockup. */
const DOUBLE_CLICK_MS = 400
/** A drag shorter than this many cells is a click, not a zoom window. */
const DRAG_CELLS = 2

export interface TraceLensProps extends LensProps {
  /** Wheel over the lens scrolls the roster and its lanes together. */
  readonly onScroll?: ((delta: number) => void) | undefined
}

/**
 * Trace: the profiler view of a run. A stacked token-rate overview, a time
 * ruler, one lane per roster row and a now column that says what each agent is
 * doing at the playhead. Every span is real data, and every frame is a pure
 * function of (spans, playhead, window), so a replay scrubs it with everything
 * else. Dragging the ruler scrubs, dragging the overview selects a zoom window
 * and a click on either moves the playhead.
 */
export function TraceLens(props: TraceLensProps) {
  const layout = createMemo(() => traceLayout(props.width))
  const rows = () => props.visible ?? props.rows

  const origin = createMemo(() => {
    const root = props.rows.find((row) => row.depth === 0)
    return Math.max(0, root?.startedAt ?? props.rows[0]?.startedAt ?? 0)
  })

  /** The newest event any loaded lane has, so a fitted window covers all of it. */
  const lastEvent = createMemo(() => {
    let last = origin()
    for (const row of props.rows) {
      last = Math.max(last, row.endedAt !== undefined && row.endedAt <= props.view.viewT() ? row.endedAt : 0)
      for (const span of props.spans.get(row.sessionID) ?? []) {
        if (span.t0 > props.view.viewT()) continue
        last = Math.max(last, span.t1 ?? span.t0)
      }
    }
    return last
  })

  const live = createMemo(() => props.rows.some((row) => isLiveState(row.state)))

  /**
   * The run's end, or undefined while it is still going. A bare session that
   * never ran is not "ended": it keeps the live fixed-scale window.
   */
  const ended = createMemo(() => {
    if (live()) return undefined
    if (!props.rows.some((row) => row.endedAt !== undefined)) return undefined
    return Math.max(origin() + 1, lastEvent())
  })

  /** Messages a lane may read: nothing after the playhead while replaying. */
  const cut = () => (props.view.live() ? Number.POSITIVE_INFINITY : props.view.viewT())

  const playhead = () => {
    const end = ended()
    const t = props.view.viewT()
    return end === undefined ? t : Math.min(t, end)
  }

  const timeWindow = () => {
    const end = ended()
    return props.view.window({
      start: origin(),
      ...(end === undefined ? {} : { end }),
      columns: layout().history,
      now: props.view.viewT(),
    })
  }

  /** Everything the overview strip floors: the whole run, never just the window. */
  const overviewEnd = () => {
    const end = ended()
    if (end !== undefined) return end
    return Math.max(origin() + 1, playhead(), lastEvent())
  }

  const laneTop = () => props.geometry.overview + props.geometry.ruler

  /** Live branches under one agent, at any depth: what a blocked row is waiting on. */
  const waitingBelow = (sessionID: string): number => {
    const byID = new Map(rows().map((row) => [row.sessionID, row]))
    let count = 0
    for (const row of rows()) {
      if (!isLiveState(row.state)) continue
      let parent = row.parentID
      while (parent !== undefined) {
        if (parent === sessionID) {
          count += 1
          break
        }
        parent = byID.get(parent)?.parentID
      }
    }
    return count
  }

  const windowed = () => {
    const per = Math.max(1, props.geometry.laneHeight)
    const selected = rows().findIndex((row) => row.sessionID === props.selected)
    const range = rosterWindow({
      total: rows().length,
      areaRows: Math.max(0, props.height - laneTop()),
      rowHeight: per,
      offset: props.offset ?? 0,
      selected: selected < 0 ? undefined : selected,
    })
    return { per, range }
  }

  const empty = createMemo(
    () => props.rows.length <= 1 && (props.rows[0] === undefined || (props.spans.get(props.rows[0].sessionID)?.length ?? 0) === 0),
  )

  /** Aim the playhead at `t`, clamped to the run; reaching the end goes live. */
  const seek = (t: number) => {
    const end = ended()
    const clock = props.view.live() ? props.view.viewT() : undefined
    const ceiling = end ?? clock ?? Number.POSITIVE_INFINITY
    const target = Math.max(origin(), Math.min(ceiling, t))
    if (end === undefined && clock !== undefined && target >= clock - 150) {
      props.view.setT(undefined)
      return
    }
    props.view.setT(target)
  }

  /** The time under one history column of the current window. */
  const timeAt = (column: number): number => {
    const win = timeWindow()
    const history = layout().history
    return win.a + ((column + 0.5) / Math.max(1, history)) * (win.b - win.a)
  }

  /** The time under one column of the overview, which always spans the whole run. */
  const overviewTime = (column: number): number => {
    const from = origin()
    return from + ((column + 0.5) / Math.max(1, layout().history)) * (overviewEnd() - from)
  }

  let drag: { readonly kind: "ruler" | "overview"; readonly x0: number; x1: number } | undefined
  let lastClick: { readonly at: number; readonly column: number } | undefined

  const regionColumn = (region: string | undefined, prefix: string): number | undefined => {
    if (region === undefined || !region.startsWith(prefix)) return undefined
    const index = Number(region.slice(prefix.length))
    return Number.isFinite(index) ? index : undefined
  }

  const onDragStart = (pointer: GridPointer) => {
    const ruler = regionColumn(pointer.region, "trace:ruler:")
    if (ruler !== undefined) {
      drag = { kind: "ruler", x0: pointer.x, x1: pointer.x }
      seek(timeAt(ruler))
      return
    }
    const overview = regionColumn(pointer.region, "trace:overview:")
    if (overview !== undefined) {
      drag = { kind: "overview", x0: pointer.x, x1: pointer.x }
    }
  }

  const onDragMove = (pointer: GridPointer) => {
    if (drag === undefined) return
    drag = { ...drag, x1: pointer.x }
    if (drag.kind === "ruler") {
      const column = Math.max(0, Math.min(layout().history - 1, pointer.x - layout().x))
      seek(timeAt(column))
      return
    }
    // A real drag selects a zoom window across the overview.
    if (Math.abs(pointer.x - drag.x0) < DRAG_CELLS) return
    const first = Math.max(0, Math.min(layout().history - 1, drag.x0 - layout().x))
    const second = Math.max(0, Math.min(layout().history - 1, pointer.x - layout().x))
    const a = Math.min(overviewTime(first), overviewTime(second))
    const b = Math.max(overviewTime(first), overviewTime(second))
    if (b - a < 4) return
    props.view.setWin({ a, b, scale: (b - a) / 1000 / Math.max(1, layout().history) })
  }

  const onDragEnd = (pointer: GridPointer) => {
    const active = drag
    drag = undefined
    if (active === undefined || active.kind !== "overview") return
    const clock = Date.now()
    const column = Math.max(0, Math.min(layout().history - 1, pointer.x - layout().x))
    const double = lastClick !== undefined && clock - lastClick.at < DOUBLE_CLICK_MS && lastClick.column === column
    lastClick = { at: clock, column }
    if (double) {
      props.view.resetZoom()
      return
    }
    // A click on the overview is a seek, not a zoom window.
    if (Math.abs(pointer.x - active.x0) < DRAG_CELLS) seek(overviewTime(column))
  }

  const hit = (region: string) => {
    if (region.startsWith("trace:call:")) {
      const parts = region.split(":")
      const sessionID = parts[2] ?? ""
      props.on.selectAgent(sessionID)
      props.on.pinCall({ sessionID, spanID: parts.slice(3).join(":") })
      return
    }
    if (region.startsWith("trace:lane:")) {
      props.on.selectAgent(region.slice("trace:lane:".length))
      props.on.pinCall(undefined)
      return
    }
    const ruler = regionColumn(region, "trace:ruler:")
    if (ruler !== undefined) {
      seek(timeAt(ruler))
      return
    }
    const overview = regionColumn(region, "trace:overview:")
    if (overview !== undefined) seek(overviewTime(overview))
  }

  const drawGrid = (grid: Grid) => {
    const theme = props.theme
    const out = layout()
    const win = timeWindow()
    const at = playhead()
    const replay = !props.view.live()
    const from = origin()
    const geometry = props.geometry
    const top = laneTop()
    const tick = props.tick
    const { per, range } = windowed()
    const list = rows().slice(range.offset, range.offset + range.count)

    if (geometry.overview > 0) {
      const to = overviewEnd()
      const series = props.rows.map((row) =>
        tokenBuckets(
          props.spans.get(row.sessionID) ?? [],
          messagesAt(props.messages(row.sessionID), cut()),
          from,
          to,
          out.history,
        ).map((bucket) => bucket.rate),
      )
      const rates = Array.from({ length: out.history }, (_, column) => series.map((list) => list[column] ?? 0))
      // The strip shares the timeline's columns: it stops where the now column
      // starts, so it never paints over the per-lane text.
      drawOverview(grid, {
        x: out.x,
        y: 0,
        width: out.history,
        rows: geometry.overview,
        rates,
        colors: props.rows.map((row) => props.hues.get(row.sessionID) ?? theme.leaf),
        selected: props.rows.findIndex((row) => row.sessionID === props.selected),
        from,
        to,
        window: win,
        playhead: at,
        replay,
        theme,
      })
    }

    drawRuler(grid, {
      layout: out,
      y: geometry.overview,
      window: win,
      origin: from,
      playhead: at,
      replay,
      live: live(),
      theme,
    })

    const body = Math.max(0, props.height - top)
    const content = Math.min(body, list.length * per)
    const legendY = content < body && props.height - 1 >= top ? props.height - 1 : undefined
    const lanesHeight = legendY === undefined ? body : Math.max(0, legendY - top)

    drawTickLines(grid, { layout: out, window: win, top, height: lanesHeight, theme })

    const positions = list.map((row, index) => {
      const laneY = top + index * per
      return { row, top: laneY, block: laneY + laneRows(per).block }
    })
    positions.forEach((entry) => {
      const pinned = props.view.pinned()
      drawLane(grid, {
        row: entry.row,
        spans: props.spans.get(entry.row.sessionID) ?? [],
        messages: messagesAt(props.messages(entry.row.sessionID), cut()),
        y: entry.top,
        height: per,
        layout: out,
        window: win,
        theme,
        hue: props.hues.get(entry.row.sessionID) ?? theme.leaf,
        selected: entry.row.sessionID === props.selected,
        animations: props.animations,
        tick,
        at,
        now: props.view.viewT(),
        live: live(),
        pinned: pinned?.sessionID === entry.row.sessionID ? pinned.spanID : undefined,
        askText: props.ask?.(entry.row.sessionID),
        waitingOn: waitingBelow(entry.row.sessionID),
      })
    })

    drawSpawnLinks(grid, { layout: out, window: win, theme, player: positions, selected: props.selected })
    drawNowLine(grid, { layout: out, window: win, top, height: lanesHeight, playhead: at, replay, live: live(), theme })

    if (empty()) drawEmpty(grid, { layout: out, top, height: lanesHeight, theme })

    if (legendY !== undefined) {
      if (empty()) {
        grid.text(out.x, legendY, "Send a message to grow the first branches.", theme.muted)
      } else {
        drawLegend(grid, {
          layout: out,
          y: legendY,
          theme,
          zoomed: props.view.win() !== undefined || props.view.scale() !== TRACE_SECONDS_PER_COLUMN,
        })
      }
    }
  }

  return (
    <CellGrid
      id="banyancode.understory.trace"
      width={Math.max(1, props.width)}
      height={Math.max(1, props.height)}
      background={props.theme.background}
      draw={drawGrid}
      onHit={hit}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onScroll={(direction, delta) => {
        if (props.onScroll === undefined) return
        if (direction === "left" || direction === "right") return
        const steps = Math.max(1, delta)
        props.onScroll(direction === "down" ? steps : -steps)
      }}
    />
  )
}
