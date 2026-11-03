import { expect, test } from "bun:test"
import {
  columnAt,
  headerRows,
  overviewRows,
  PAGE_FRACTION,
  PAGE_TRIGGER,
  rowGeometry,
  rosterAreaRows,
  TRACE_SCALE_MAX,
  TRACE_SCALE_MIN,
  TRACE_SECONDS_PER_COLUMN,
  traceWindow,
  zoomScale,
} from "../src/components/understory/layout"
import { createUnderstoryView, LENSES, lensForKey, lensLabel } from "../src/components/understory/view"

test("header rows follow the brief's three tiers", () => {
  expect(overviewRows(55)).toBe(3)
  expect(headerRows(55)).toBe(5)
  expect(overviewRows(48)).toBe(3)
  expect(overviewRows(40)).toBe(3)
  expect(overviewRows(36)).toBe(3)
  expect(overviewRows(35)).toBe(2)
  expect(overviewRows(30)).toBe(2)
  expect(overviewRows(28)).toBe(2)
  expect(overviewRows(27)).toBe(0)
  expect(overviewRows(24)).toBe(0)
  expect(headerRows(24)).toBe(2)
})

test("the lane picker takes the largest height that fits and says when it cannot", () => {
  // 6 branches at 200x55: header 5 leaves 50 rows, and 4 rows each (24) fits.
  const roomy = rowGeometry(55, 6)
  expect(roomy.header).toBe(5)
  expect(roomy.lanesArea).toBe(50)
  expect(roomy.laneHeight).toBe(4)
  expect(roomy.visibleLanes).toBe(6)
  expect(roomy.overflow).toBe(false)

  // 21 branches at 55 rows: 3 rows each (63) does not fit 50, 2 rows each fits.
  const medium = rowGeometry(55, 21)
  expect(medium.laneHeight).toBe(2)
  expect(medium.visibleLanes).toBe(21)

  // 21 branches at 24 rows: only one row each, and still fewer lanes than agents.
  const tight = rowGeometry(24, 21)
  expect(tight.laneHeight).toBe(1)
  expect(tight.visibleLanes).toBe(21)
  expect(tight.overflow).toBe(false)

  const crowded = rowGeometry(18, 21)
  expect(crowded.laneHeight).toBe(1)
  expect(crowded.visibleLanes).toBe(16)
  expect(crowded.overflow).toBe(true)

  // A last row is always free for the legend, so a height that exactly fills
  // the area is one size too tall (100x30: 9 agents, 18 rows).
  const exact = rowGeometry(20, 9)
  expect(exact.lanesArea).toBe(18)
  expect(exact.laneHeight).toBe(1)
})

test("the roster and the lanes read the same header height", () => {
  for (const rows of [55, 48, 40, 36, 30, 28, 24, 18]) {
    const geometry = rowGeometry(rows, 4)
    expect(geometry.header).toBe(headerRows(rows))
    expect(rosterAreaRows(rows)).toBe(geometry.lanesArea)
  }
})

test("a live window keeps a fixed scale and pages forward in 30% steps", () => {
  const columns = 100
  const start = 0
  const span = columns * TRACE_SECONDS_PER_COLUMN
  expect(span).toBe(70)

  const first = traceWindow({ start, now: 10, columns })
  expect(first.a).toBe(0)
  expect(first.b).toBe(70)
  expect(first.scale).toBe(TRACE_SECONDS_PER_COLUMN)

  // History stays still until the now line reaches 90% of the window.
  const boundary = traceWindow({ start, now: span * PAGE_TRIGGER - 0.01, columns })
  expect(boundary.a).toBe(0)

  // Past that, the window steps forward by 30% of its width and no further.
  const paged = traceWindow({ start, now: span * PAGE_TRIGGER + 0.01, columns })
  expect(paged.a).toBeCloseTo(span * PAGE_FRACTION, 6)
  expect(paged.b - paged.a).toBe(span)

  const far = traceWindow({ start, now: span * (PAGE_TRIGGER + PAGE_FRACTION * 2.5), columns })
  expect(far.a).toBeCloseTo(span * PAGE_FRACTION * 3, 6)
})

test("an ended run fits the whole run into the columns", () => {
  const window = traceWindow({ start: 100, end: 5_100, now: 9_999, columns: 100 })
  expect(window.a).toBe(100)
  expect(window.b).toBe(5_100)
  expect(window.scale).toBe(50)
})

test("zoom halves and doubles seconds per column inside its bounds", () => {
  expect(zoomScale(0.7, 1)).toBe(0.35)
  expect(zoomScale(0.7, -1)).toBe(1.4)
  expect(zoomScale(0.01, 1)).toBe(TRACE_SCALE_MIN)
  expect(zoomScale(100, -1)).toBe(TRACE_SCALE_MAX)
})

test("a time maps to its column inside the window", () => {
  const window = { a: 10, b: 20, scale: 0.1 }
  expect(columnAt(window, 100, 15)).toBe(50)
  expect(columnAt(window, 100, 10)).toBe(0)
  expect(columnAt(window, 100, 20)).toBe(100)
})

test("the view holds the lens, the playhead and the lens-only controls", () => {
  let now = 1_000
  const view = createUnderstoryView({ now: () => now })
  expect(view.lens()).toBe("trace")
  expect(view.live()).toBe(true)
  expect(view.viewT()).toBe(1_000)

  now = 2_000
  expect(view.viewT()).toBe(2_000)

  view.setT(1_500)
  expect(view.live()).toBe(false)
  expect(view.viewT()).toBe(1_500)
  // The window pages to keep the playhead inside it, never past 90% of its width.
  // The view speaks milliseconds; the fixed scale is 0.7 s per column.
  const window = view.window({ start: 0, columns: 100 })
  expect(window.b - window.a).toBeCloseTo(70_000, 6)
  expect(window.a).toBeLessThanOrEqual(1_500)
  expect(1_500).toBeLessThanOrEqual(window.a + (window.b - window.a) * PAGE_TRIGGER)

  view.setT(undefined)
  expect(view.live()).toBe(true)
  expect(view.viewT()).toBe(2_000)

  view.setLens("trace")
  expect(view.lens()).toBe("trace")
  // Zoom follows the mockup: the span shrinks or grows by 0.7 / 1.4, kept
  // between five seconds and the run plus fifteen, around the playhead.
  const before = view.window({ start: 0, columns: 100 })
  expect(before.b - before.a).toBeCloseTo(70_000, 6)
  view.zoom(1)
  const zoomed = view.window({ start: 0, columns: 100 })
  expect(zoomed.b - zoomed.a).toBeLessThan(before.b - before.a)
  expect(zoomed.b - zoomed.a).toBe(49_000)
  expect(view.scale()).toBeCloseTo((zoomed.b - zoomed.a) / 1000 / 100, 6)
  // The playhead sits inside a scrubbed window, never before the run.
  expect(zoomed.a).toBeLessThanOrEqual(view.viewT())
  view.resetZoom()
  expect(view.win()).toBeUndefined()
  expect(view.scale()).toBe(TRACE_SECONDS_PER_COLUMN)
  expect(view.window({ start: 0, columns: 100 }).b - view.window({ start: 0, columns: 100 }).a).toBeCloseTo(70_000, 6)
  view.zoom(-1)
  expect(view.window({ start: 0, columns: 100 }).b - view.window({ start: 0, columns: 100 }).a).toBeGreaterThan(70_000)

  view.setFilter(true)
  view.setOverlay(true)
  view.setBlast(true)
  expect(view.filter()).toBe(true)
  expect(view.overlay()).toBe(true)
  expect(view.blast()).toBe(true)

  view.pinCall({ sessionID: "ses_1", spanID: "msg:0" })
  view.selectFile("packages/cli/script/postinstall.mjs")
  expect(view.pinned()).toEqual({ sessionID: "ses_1", spanID: "msg:0" })
  expect(view.file()).toBe("packages/cli/script/postinstall.mjs")
})

test("every lens is labelled for the tab strip", () => {
  expect(LENSES.map(lensLabel)).toEqual(["Trace", "Roots", "Stream"])
})

test("only a real digit press names a lens", () => {
  // `@opentui/keymap` can match a bare digit for a key that is not one (the
  // base-layout fallback), so the lens commands check the event's own name.
  expect(lensForKey("1")).toBe("trace")
  expect(lensForKey("2")).toBe("roots")
  expect(lensForKey("3")).toBe("stream")
  expect(lensForKey("]")).toBeUndefined()
  expect(lensForKey("escape")).toBeUndefined()
  expect(lensForKey(undefined)).toBeUndefined()
})
