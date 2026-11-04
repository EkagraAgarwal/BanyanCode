/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo } from "solid-js"
import { isLiveState } from "../../../data/understory"
import type { RosterRow } from "../../../data/understory"
import { messagesAt, tokenBuckets } from "../../../data/understory-spans"
import { CellGrid, type Grid, type GridPointer } from "../cells"
import { HISTORY_LOAD_FRACTION, rosterWindow, TRACE_SECONDS_PER_COLUMN, WHEEL_FRACTION } from "../layout"
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
import { readTick } from "../view"

/** A double click inside the overview resets the zoom, like the mockup. */
const DOUBLE_CLICK_MS = 400
/** A drag shorter than this many cells is a click, not a zoom window. */
const DRAG_CELLS = 2

export interface TraceLensProps extends LensProps {
  /** Wheel over the lens scrolls the roster and its lanes together. */
  readonly onScroll?: ((delta: number) => void) | undefined
  /** Coarse live clock (one step per second); omitted means `view.viewT()`. */
  readonly playhead?: number | undefined
  /** True while the session has an older page the host can still serve. */
  readonly historyMore?: ((sessionID: string) => boolean | undefined) | undefined
  /** True while that session's older page is already in flight. */
  readonly historyLoading?: ((sessionID: string) => boolean) | undefined
  /** Ask the host for one older page of a session's messages. */
  readonly loadOlder?: ((sessionID: string) => void) | undefined
}

/**
 * Trace: the profiler view of a run. A stacked token-rate overview, a time
 * ruler, one lane per roster row and a now column that says what each agent is
 * doing at the playhead. Every span is real data, and every frame is a pure
 * function of (spans, playhead, window), so a replay scrubs it with everything
 * else. Dragging the ruler scrubs, dragging the overview selects a zoom window
 * and a click on the overview moves the time window.
 */
export function TraceLens(props: TraceLensProps) {
  const layout = createMemo(() => traceLayout(props.width))
  const rows = () => props.visible ?? props.rows
  /** The playhead the lens draws: a coarse live clock, else the scrub time. */
  const time = () => props.playhead ?? props.view.viewT()

  const origin = createMemo(() => {
    const root = props.rows.find((row) => row.depth === 0)
    return Math.max(0, root?.startedAt ?? props.rows[0]?.startedAt ?? 0)
  })

  /**
   * The newest event any loaded lane has. This is data only: a span starting
   * or ending, a message appearing or completing. It never reads the clock, so
   * the window cannot drift while nothing happens. The per-session derivation
   * already carries both numbers, so this reads one value per row.
   */
  const lastEvent = createMemo(() => {
    let last = origin()
    for (const row of props.rows) {
      const data = props.session?.(row.sessionID)
      if (data !== undefined) {
        last = Math.max(last, row.startedAt, row.endedAt ?? 0, data.newestAt, data.completedAt, data.spanEnd)
        continue
      }
      last = Math.max(last, row.startedAt, row.endedAt ?? 0)
      for (const span of props.spans.get(row.sessionID) ?? []) last = Math.max(last, span.t0, span.t1 ?? 0)
      for (const message of props.messages(row.sessionID)) {
        last = Math.max(last, message.time.created)
        if (message.type === "assistant" && message.time.completed !== undefined) {
          last = Math.max(last, message.time.completed)
        }
      }
    }
    return last
  })

  /** The newest event the playhead has reached; a replay must not show later work. */
  const horizonEvent = createMemo(() => Math.min(lastEvent(), time()))

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
    const t = time()
    return end === undefined ? t : Math.min(t, end)
  }

  const timeWindow = () => {
    const end = ended()
    return props.view.window({
      start: origin(),
      ...(end === undefined ? {} : { end }),
      columns: layout().history,
      now: time(),
      newest: lastEvent(),
    })
  }

  /** Everything the overview strip floors: the whole run, never just the window. */
  const overviewEnd = () => {
    const end = ended()
    if (end !== undefined) return end
    // The strip is a whole-run summary; quantising its right edge to the second
    // keeps it off every event, so one streamed part does not rebuild twenty
    // sessions' overview series.
    return Math.max(origin() + 1, Math.ceil(Math.max(playhead(), horizonEvent()) / 1000) * 1000)
  }

  const laneTop = () => props.geometry.overview + props.geometry.ruler

  /** Live branches under one agent, at any depth: what a blocked row is waiting on. */
  const waitingCounts = (list: readonly RosterRow[]): ReadonlyMap<string, number> => {
    const byID = new Map(list.map((row) => [row.sessionID, row]))
    const counts = new Map<string, number>()
    for (const row of list) {
      if (!isLiveState(row.state)) continue
      let parent = row.parentID
      while (parent !== undefined) {
        counts.set(parent, (counts.get(parent) ?? 0) + 1)
        parent = byID.get(parent)?.parentID
      }
    }
    return counts
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

  /** The run bounds every manual scroll is clamped to. */
  const bounds = () => {
    const end = ended()
    return { start: origin(), newest: lastEvent(), ...(end === undefined ? {} : { end }) }
  }

  /** Shift the time window by a fraction of its width. */
  const scrollBy = (fraction: number) => {
    if (fraction === 0) return
    const range = bounds()
    props.view.scrollTime({
      start: range.start,
      newest: range.newest,
      ...(range.end === undefined ? {} : { end: range.end }),
      fraction,
    })
  }

  /** Bring an overview time into view, moving the window as little as possible. */
  const jumpTo = (t: number) => {
    const win = timeWindow()
    const span = Math.max(1, win.b - win.a)
    scrollBy((t - (win.a + win.b) / 2) / span)
  }

  /**
   * One older page per session when its oldest loaded span comes near the left
   * edge. The window start is the guard: a page load alone must not ask again,
   * only a further scroll does. This is data-driven, not per frame.
   */
  const historyAsked = new Map<string, unknown>()
  createEffect(() => {
    const load = props.loadOlder
    if (load === undefined) return
    const win = timeWindow()
    const threshold = (win.b - win.a) * HISTORY_LOAD_FRACTION
    const { range } = windowed()
    for (const row of rows().slice(range.offset, range.offset + range.count)) {
      if (props.historyMore?.(row.sessionID) !== true) continue
      if (props.historyLoading?.(row.sessionID) === true) continue
      const oldest = (props.spans.get(row.sessionID) ?? []).reduce(
        (min, span) => Math.min(min, span.t0),
        Number.POSITIVE_INFINITY,
      )
      // The oldest span must be at or just left of the window's left edge; a
      // window far to the right of it is scrolling recent work, not history.
      if (!Number.isFinite(oldest) || oldest > win.b || win.a - oldest > threshold) continue
      // A fixed window is its own marker, so each further scroll at a clamped
      // edge asks again; a followed window keys on its start, so a page load
      // alone does not cascade into the next page.
      const marker = props.view.win() ?? win.a
      if (historyAsked.get(row.sessionID) === marker) continue
      historyAsked.set(row.sessionID, marker)
      load(row.sessionID)
    }
  })

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

  let drag: { readonly kind: "ruler" | "overview" | "lanes"; readonly x0: number; x1: number } | undefined
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
      return
    }
    // Lanes pan the time axis: a drag is the same gesture as the ruler's scrub,
    // but it moves what is visible rather than the playhead.
    if (pointer.region?.startsWith("trace:lane:") === true || pointer.region?.startsWith("trace:call:") === true) {
      drag = { kind: "lanes", x0: pointer.x, x1: pointer.x }
    }
  }

  const onDragMove = (pointer: GridPointer) => {
    if (drag === undefined) return
    if (drag.kind === "lanes") {
      const dx = pointer.x - drag.x1
      drag = { ...drag, x1: pointer.x }
      if (dx !== 0) scrollBy(-dx / Math.max(1, layout().history))
      return
    }
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
    // A click on the overview moves the window, not the playhead.
    if (Math.abs(pointer.x - active.x0) < DRAG_CELLS) jumpTo(overviewTime(column))
  }

  const hit = (region: string) => {
    if (region === "trace:reset-zoom") {
      props.view.resetZoom()
      return
    }
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
    if (overview !== undefined) jumpTo(overviewTime(overview))
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
    const newest = lastEvent()
    const { per, range } = windowed()
    const list = rows().slice(range.offset, range.offset + range.count)
    // The grid animates only when animations are on and something in it can
    // move (a running lane's shimmer, a waiting lane's breath). Otherwise a
    // ticker frame must not repaint the lens at all, so the tick is not read.
    const animated = props.animations && list.some((row) => row.state === "running" || row.state === "waiting")
    const tick = animated ? readTick(props.tick) : 0

    if (geometry.overview > 0) {
      const to = overviewEnd()
      // The overview spans the whole run; a lane spans the visible window. Both
      // go through the same per-session memo, so a run that fits its window (the
      // common ended case) builds one set of buckets and both readers reuse it.
      const series = props.rows.map((row) =>
        tokenBuckets(
          props.spans.get(row.sessionID) ?? [],
          messagesAt(props.messages(row.sessionID), cut()),
          from,
          to,
          out.history,
          props.session?.(row.sessionID),
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
    const below = waitingCounts(list)
    const pinned = props.view.pinned()
    positions.forEach((entry) => {
      drawLane(grid, {
        row: entry.row,
        spans: props.spans.get(entry.row.sessionID) ?? [],
        messages: messagesAt(props.messages(entry.row.sessionID), cut()),
        bucketOwner: props.session?.(entry.row.sessionID),
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
        now: time(),
        newest,
        live: live(),
        pinned: pinned?.sessionID === entry.row.sessionID ? pinned.spanID : undefined,
        askText: props.ask?.(entry.row.sessionID),
        waitingOn: below.get(entry.row.sessionID) ?? 0,
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
      onScroll={(direction, delta, modifiers) => {
        const steps = Math.max(1, delta)
        // A horizontal wheel, or shift on a vertical one, moves time. Plain
        // vertical wheel still scrolls the roster and its lanes together.
        if (direction === "left" || direction === "right" || modifiers?.shift === true) {
          const back = direction === "left" || direction === "up"
          scrollBy((back ? -1 : 1) * steps * WHEEL_FRACTION)
          return
        }
        props.onScroll?.(direction === "down" ? steps : -steps)
      }}
    />
  )
}
