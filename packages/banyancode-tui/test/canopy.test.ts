import { expect, test } from "bun:test"
import { canopyLevel, canopyRuns } from "../src/components/status/canopy"
import { chromeLayout } from "../src/components/status/session-chrome"

const text = (runs: ReturnType<typeof canopyRuns>) => runs.map((run) => run.text).join("")

test("an idle canopy is one unlit run: no highlight, nothing to animate", () => {
  const runs = canopyRuns({ width: 40, tick: 0, busy: false })
  expect(runs).toHaveLength(1)
  expect(runs[0]).toEqual({ text: "─".repeat(40), level: 0, active: false })
})

test("the highlight sweeps when busy and is gone again when idle", () => {
  const early = canopyRuns({ width: 80, tick: 0.5, busy: true })
  const later = canopyRuns({ width: 80, tick: 1.5, busy: true })
  expect(text(early)).toBe("─".repeat(80))
  expect(early.length).toBeGreaterThan(1)
  expect(early.some((run) => run.level > 0)).toBe(true)
  expect(early.map((run) => run.level)).not.toEqual(later.map((run) => run.level))
  expect(canopyLevel(0, 0.5, 80)).toBeGreaterThan(0.9)
  expect(canopyLevel(60, 0.5, 80)).toBeLessThan(0.01)
})

test("the second lobe is smaller than the main one", () => {
  // At tick 0 the main head sits at -20 and the second lobe at width * 0.55 - 20.
  const second = (80 * 0.55 - 20) | 0
  expect(canopyLevel(second, 0, 80)).toBeGreaterThan(0)
  expect(canopyLevel(second, 0, 80)).toBeLessThan(canopyLevel(0, 0.5, 80))
})

test("the active tab is a heavy segment on the exact columns of its label", () => {
  const layout = chromeLayout({ width: 160, active: "agents", project: "banyancode" })
  const agents = layout.tabs.find((tab) => tab.key === "agents")!
  // Brand ends at column 15, project at 26, tabs start at 29.
  expect(agents.labelStart).toBe(47)
  expect(agents.segmentStart).toBe(agents.labelStart - 1)
  expect(agents.width).toBe("AGENTS".length + 2)

  const runs = canopyRuns({
    width: 160,
    tick: 0.5,
    busy: false,
    activeStart: agents.segmentStart,
    activeWidth: agents.width,
  })
  const heavy = runs.filter((run) => run.active)
  expect(heavy.map((run) => run.text).join("")).toBe("━".repeat(agents.width))
  let column = 0
  for (const run of runs) {
    if (run.active) expect(column).toBe(agents.segmentStart)
    column += run.text.length
  }
  expect(text(runs)).toHaveLength(160)
})

test("row 0 geometry never overflows, at any width", () => {
  const statuses = [
    { text: "◉ 2 agents", tone: "success" as const },
    { text: "ctx 12%", tone: "neutral" as const },
    { text: "Graph: built", tone: "success" as const },
    { text: "● LSP", tone: "success" as const },
  ]
  for (const width of [200, 160, 120, 91, 90, 80, 62, 61, 44, 40, 35, 30, 12]) {
    const layout = chromeLayout({ width, active: "config", project: "a-very-long-project-name-here", statuses })
    expect(layout.tabs.length).toBeGreaterThan(0)
    expect(layout.tabsEnd).toBeLessThanOrEqual(width)
    for (const tab of layout.tabs) {
      expect(tab.labelStart + tab.label.length).toBeLessThanOrEqual(width)
    }
    for (const status of layout.statuses) {
      expect(status.start + status.text.length).toBeLessThan(width)
    }
    if (layout.statuses.length > 0) {
      expect(layout.statuses[0]!.start).toBeGreaterThan(layout.tabsEnd)
    }
  }
})

test("the project is truncated, the brand name drops before the glyph, then the tabs", () => {
  const wide = chromeLayout({ width: 160, active: "chat", project: "a-very-long-project-name-here" })
  expect(wide.project?.name).toBe("a-very-long-project…")
  expect(wide.name).toBe(true)

  const medium = chromeLayout({ width: 70, active: "chat", project: "banyancode" })
  expect(medium.project).toBeUndefined()
  expect(medium.name).toBe(true)
  expect(medium.tabs).toHaveLength(4)

  const narrow = chromeLayout({ width: 44, active: "agents", project: "banyancode" })
  expect(narrow.glyph).toBe(true)
  expect(narrow.name).toBe(false)
  expect(narrow.tabs).toHaveLength(4)

  const tiny = chromeLayout({ width: 38, active: "sessions" })
  expect(tiny.glyph).toBe(false)
  expect(tiny.tabs).toHaveLength(4)

  const minimal = chromeLayout({ width: 24, active: "sessions" })
  expect(minimal.tabs).toHaveLength(1)
  expect(minimal.tabs[0]!.key).toBe("sessions")
})
