/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { isLiveState } from "../../../data/understory"
import { tokenBuckets } from "../../../data/understory-spans"
import { CellGrid, type Grid } from "../cells"
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

/**
 * Trace: the profiler view of a run. A stacked token-rate overview, a time
 * ruler, one lane per roster row and a now column that says what each agent is
 * doing at the playhead. Every span is real data, and every frame is a pure
 * function of (spans, playhead, window), so a replay scrubs it with everything
 * else.
 */
export function TraceLens(props: LensProps) {
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
      last = Math.max(last, row.endedAt ?? 0)
      for (const span of props.spans.get(row.sessionID) ?? []) last = Math.max(last, span.t1 ?? span.t0)
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

  /** Click a lane to select, a block to pin it, the ruler or overview to aim the playhead. */
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
    if (region.startsWith("trace:ruler:")) {
      const index = Number(region.slice("trace:ruler:".length))
      const history = layout().history
      if (!Number.isFinite(index) || history <= 0) return
      const win = timeWindow()
      seek(win.a + ((index + 0.5) / history) * (win.b - win.a))
      return
    }
    if (region.startsWith("trace:overview:")) {
      const index = Number(region.slice("trace:overview:".length))
      const width = layout().inner
      if (!Number.isFinite(index) || width <= 0) return
      seek(origin() + ((index + 0.5) / width) * (overviewEnd() - origin()))
    }
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
        tokenBuckets(props.spans.get(row.sessionID) ?? [], props.messages(row.sessionID), from, to, out.inner).map(
          (bucket) => bucket.rate,
        ),
      )
      const rates = Array.from({ length: out.inner }, (_, column) => series.map((list) => list[column] ?? 0))
      drawOverview(grid, {
        x: out.x,
        y: 0,
        width: out.inner,
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
        messages: props.messages(entry.row.sessionID),
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
        waitingOn: rows().filter((row) => row.parentID === entry.row.sessionID && isLiveState(row.state)).length,
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
          zoomed: props.view.scale() !== TRACE_SECONDS_PER_COLUMN,
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
    />
  )
}
