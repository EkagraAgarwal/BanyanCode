/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { bloomSpans, BLOOM_CHARS } from "../src/components/understory/stream"
import { TraceLens } from "../src/components/understory/trace"
import { Understory } from "../src/components/understory"
import { CellGridRenderable } from "../src/components/understory/cells"
import { createUnderstoryView, type LensProps } from "../src/components/understory/view"
import { branchHue } from "../src/components/understory/hue"
import { rowGeometry } from "../src/components/understory/layout"
import { rosterRows } from "../src/data/understory"
import { agentSpans } from "../src/data/understory-spans"
import { kindColor, palette } from "../src/theme"
import { mount, theme as harnessTheme } from "./harness"
import { clickRegion, INSPECTOR_ACTIONS, LENS_TABS, regions, ROSTER, TRACE } from "./fixture/click"
import { fakeTimers, understoryFixture, type UnderstorySpec } from "./fixture/understory"

/**
 * Replay: every pane is a pure function of (session history, time). These tests
 * scrub one playhead and check that the roster, the lanes, the map, the
 * inspector and the stream all move with it, that nothing after it exists, and
 * that the keys which write to the run refuse while it is scrubbed.
 */

const NOW = 12_000
/** Two real tool calls on the same branch, two seconds apart. */
const READ_AT = 2_100
const READ_DONE = 2_300
const SHELL_AT = 5_100
const SHELL_DONE = 7_600

const SPECS: readonly UnderstorySpec[] = [
  {
    id: "ses_coder",
    agent: "coder",
    title: "Rewrite the installer fallback",
    state: "running",
    tokens: 3_000,
    cost: 0.02,
    created: 1_000,
  },
]

const usage = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function toolMessage(input: {
  readonly id: string
  readonly created: number
  readonly completed: number
  readonly tokens: number
  readonly name: string
  readonly file: string
}): SessionMessageInfo {
  return {
    id: input.id,
    type: "assistant",
    time: { created: input.created, completed: input.completed },
    agent: "coder",
    model: { providerID: "provider", id: "deepseek-v4.1-flash" },
    tokens: usage(input.tokens),
    content: [
      {
        type: "tool",
        id: `${input.id}_part`,
        name: input.name,
        state: {
          status: "completed",
          input: { filePath: input.file, command: input.file },
          content: [{ type: "text", text: "" }],
          metadata: {},
        },
        time: { created: input.created, completed: input.completed },
      },
    ],
  } as unknown as SessionMessageInfo
}

/** One fixture with real tool parts: a read at 2.1 s, a shell call at 5.1 s. */
function fixture() {
  const value = understoryFixture({ specs: SPECS, limit: 20 })
  value.append(
    "ses_coder",
    toolMessage({
      id: "m_read",
      created: READ_AT,
      completed: READ_DONE,
      tokens: 1_000,
      name: "read",
      file: "postinstall.mjs",
    }),
  )
  value.append(
    "ses_coder",
    toolMessage({
      id: "m_shell",
      created: SHELL_AT,
      completed: SHELL_DONE,
      tokens: 2_000,
      name: "bash",
      file: "npm pack --dry-run",
    }),
  )
  return value
}

async function mountPanel() {
  const value = fixture()
  const app = await mount(
    () => <Understory context={value.context} sessionID="ses_root" mesh={value.mesh} now={() => NOW} />,
    { width: 168, height: 48 },
  )
  await app.renderOnce()
  // The first branch, as a user picks a lane before scrubbing.
  await clickRegion(app, ROSTER, "row:ses_coder")
  await app.renderOnce()
  await app.renderOnce()
  return { app, fixture: value }
}


const frame = (app: Awaited<ReturnType<typeof mount>>) => app.captureCharFrame()

test("scrubbing moves the roster, the lanes and the inspector together", async () => {
  const { app } = await mountPanel()
  try {
    const liveFrame = frame(app)
    expect(liveFrame).toContain("LIVE")
    // Both calls, and the tokens of both completed messages.
    expect(liveFrame).toContain("TOOLS 2")
    expect(liveFrame).toContain("3.0k")

    // The ruler's first column sits before every event in this run.
    expect(await clickRegion(app, TRACE, "trace:ruler:0")).toBe(true)
    await app.renderOnce()
    await app.renderOnce()
    const scrubbed = frame(app)
    expect(scrubbed).toContain("back to live")
    expect(scrubbed).not.toContain("TOOLS 2")
    // No message had completed by the playhead, so no tokens exist yet.
    expect(scrubbed).not.toContain("3.0k")
    // The tree order and the labels never move.
    expect(scrubbed).toContain("coder")
  } finally {
    app.renderer.destroy()
  }
})
test("a tool part after the playhead is absent from the stream", async () => {
  const { app } = await mountPanel()
  try {
    await clickRegion(app, LENS_TABS, "lens:stream")
    await app.renderOnce()
    const liveFrame = frame(app)
    expect(liveFrame).toContain("read postinstall.mjs")
    expect(liveFrame).toContain("npm pack --dry-run")

    // Scrub on the ruler, then read the stream at the same playhead.
    await clickRegion(app, LENS_TABS, "lens:trace")
    await clickRegion(app, TRACE, "trace:ruler:0")
    await clickRegion(app, LENS_TABS, "lens:stream")
    await app.renderOnce()
    await app.renderOnce()
    const scrubbed = frame(app)
    expect(scrubbed).toContain("back to live")
    expect(scrubbed).not.toContain("read postinstall.mjs")
    expect(scrubbed).not.toContain("npm pack --dry-run")
  } finally {
    app.renderer.destroy()
  }
})
test("the Roots map redraws for the playhead, not for the wall clock", async () => {
  const { app } = await mountPanel()
  try {
    await clickRegion(app, LENS_TABS, "lens:roots")
    await app.renderOnce()
    await app.renderOnce()
    // The lens remounts on every tab switch, so look the grid up each time.
    const cellsOf = () =>
      (app.renderer.root.findDescendantById("banyancode.understory.roots") as unknown as CellGridRenderable).grid
        .cells()
        .map((cell) => (cell.glyph === " " ? "" : cell.glyph) + [cell.fg, cell.bg].map((color) => color.toInts().join(",")).join("|"))
    const live = cellsOf()

    await clickRegion(app, LENS_TABS, "lens:trace")
    await clickRegion(app, TRACE, "trace:ruler:0")
    await clickRegion(app, LENS_TABS, "lens:roots")
    await app.renderOnce()
    await app.renderOnce()
    expect(frame(app)).toContain("back to live")
    expect(cellsOf().join("\n")).not.toBe(live.join("\n"))
    // Root curves only reach files the branch had touched by the playhead.
    expect(frame(app)).toContain("/codegraph-build")
  } finally {
    app.renderer.destroy()
  }
})
test("steer, kill and permission answers are off while replaying, and say so", async () => {
  const { app, fixture: value } = await mountPanel()
  try {
    value.pending("ses_coder", 1)
    await clickRegion(app, TRACE, "trace:ruler:0")
    await app.renderOnce()
    await app.renderOnce()
    expect(frame(app)).toContain("back to live")

    // The action row offers the way back instead of the writes.
    expect(regions(app, INSPECTOR_ACTIONS)).toEqual(["live"])
    expect(value.steers).toHaveLength(0)
    expect(value.kills).toHaveLength(0)
    expect(value.replies).toHaveLength(0)

    expect(await clickRegion(app, INSPECTOR_ACTIONS, "live")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("LIVE")
  } finally {
    app.renderer.destroy()
  }
})
test("the replay badge returns to live and the newest work comes back", async () => {
  const { app } = await mountPanel()
  try {
    expect(await clickRegion(app, TRACE, "trace:ruler:0")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("back to live")
    expect(await clickRegion(app, LENS_TABS, "lens:live")).toBe(true)
    await app.renderOnce()
    await app.renderOnce()
    const back = frame(app)
    expect(back).toContain("LIVE")
    expect(back).not.toContain("back to live")
    expect(back).toContain("TOOLS 2")
  } finally {
    app.renderer.destroy()
  }
})
test("the replay badge says how to leave, and clicking it resumes live streaming", async () => {
  const { app } = await mountPanel()
  try {
    await clickRegion(app, TRACE, "trace:ruler:0")
    await app.renderOnce()
    await app.renderOnce()
    const scrubbed = frame(app)
    expect(scrubbed).toContain("back to live")
    expect(scrubbed).not.toContain("TOOLS 2")

    expect(await clickRegion(app, LENS_TABS, "lens:live")).toBe(true)
    await app.renderOnce()
    await app.renderOnce()
    const live = frame(app)
    expect(live).toContain("LIVE")
    expect(live).not.toContain("back to live")
    expect(live).toContain("TOOLS 2")
  } finally {
    app.renderer.destroy()
  }
})
test("the newest stream text blooms from the highlight into the text colour", () => {
  const base = palette(harnessTheme)
  const theme = { ...base, highlight: RGBA.fromInts(255, 0, 0, 255), text: RGBA.fromInts(0, 0, 255, 255) }
  const text = "one two three four five"
  const spans = bloomSpans(text, theme)
  expect(spans.map((part) => part.text).join("")).toBe(text)
  const tail = spans.slice(-BLOOM_CHARS)
  expect(tail).toHaveLength(BLOOM_CHARS)
  // The head is the final text colour; the tail ramps into it.
  const head = spans.at(0)!
  expect(head.text).toBe(text.slice(0, text.length - BLOOM_CHARS))
  expect(head.color.toInts()).toEqual(theme.text.toInts())
  expect(tail[0]!.color.toInts()).not.toEqual(theme.text.toInts())
  expect(tail.at(-1)!.color.toInts()).toEqual(theme.text.toInts())
  // A short line blooms whole, and an empty one draws nothing.
  expect(bloomSpans("ab", theme).map((part) => part.text)).toEqual(["a", "b"])
  expect(bloomSpans("", theme)).toEqual([])
})

test("an idle panel renders nothing and runs no timers with animations off", async () => {
  const value = understoryFixture({ specs: [], rootMessages: false, animations: false })
  const clock = fakeTimers(NOW)
  const app = await mount(
    () => (
      <Understory
        context={value.context}
        sessionID="ses_root"
        mesh={value.mesh}
        timers={{ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }}
        now={clock.now}
      />
    ),
    { width: 120, height: 40 },
  )
  try {
    await app.renderOnce()
    const first = frame(app)
    await Bun.sleep(20)
    await app.renderOnce()
    expect(frame(app)).toBe(first)
    expect(clock.count()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

// ---------------------------------------------------------------------------
// Mouse on the Trace lens: the ruler, the overview and the wheel
// ---------------------------------------------------------------------------

function traceProps(playhead: number | undefined): LensProps & { readonly scrolled: number[] } {
  const value = fixture()
  const messagesOf = (sessionID: string) => value.context.data.session.message.list(sessionID)
  const rows = rosterRows({
    root: "ses_root",
    sessions: value.sessions,
    mesh: value.mesh.root("ses_root"),
    messages: messagesOf,
  })
  const spans = new Map(rows.map((row) => [row.sessionID, agentSpans(messagesOf(row.sessionID))]))
  const view = createUnderstoryView({ now: () => NOW })
  view.setT(playhead)
  const scrolled: number[] = []
  return {
    rows,
    visible: rows,
    offset: 0,
    spans,
    messages: messagesOf,
    hues: new Map(rows.map((row, index) => [row.sessionID, branchHue(index, "dark") as RGBA])),
    theme: palette(harnessTheme),
    view,
    selected: rows[1]?.sessionID,
    width: 120,
    height: 34,
    geometry: rowGeometry(40, rows.length),
    animations: false,
    tick: 0,
    on: { selectAgent: () => {}, pinCall: () => {}, selectFile: () => {} },
    scrolled,
  }
}

async function renderTrace(props: LensProps & { readonly scrolled?: number[] }) {
  const app = await mount(
    () => <TraceLens {...props} onScroll={(delta) => props.scrolled?.push(delta)} />,
    { width: props.width, height: props.height },
  )
  await app.renderOnce()
  await app.renderOnce()
  return app
}

test("real tool parts draw lane blocks, and the now column counts them", async () => {
  const props = traceProps(undefined)
  const app = await renderTrace(props)
  try {
    const node = app.renderer.root.findDescendantById("banyancode.understory.trace") as unknown as CellGridRenderable
    const theme = palette(harnessTheme)
    const read = kindColor("R", theme).toInts().join(",")
    const shell = kindColor("$", theme).toInts().join(",")
    const cells = node.grid.cells()
    expect(cells.some((cell) => cell.fg.toInts().join(",") === read)).toBe(true)
    expect(cells.some((cell) => cell.fg.toInts().join(",") === shell)).toBe(true)
    // The now column repeats the count, so the lane never reads empty.
    expect(frame(app)).toContain("2 tools")
    expect(frame(app)).toContain("3.0k")
  } finally {
    app.renderer.destroy()
  }
})

test("dragging the ruler scrubs the playhead", async () => {
  const props = traceProps(undefined)
  const app = await renderTrace(props)
  try {
    const y = props.geometry.overview
    await app.mockMouse.drag(4, y, 44, y)
    await app.renderOnce()
    expect(props.view.t()).toBeDefined()
    expect(props.view.live()).toBe(false)
    // A drag across the ruler is a scrub, not a zoom window.
    expect(props.view.win()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("dragging the overview selects a zoom window and returns with 0", async () => {
  const props = traceProps(undefined)
  const app = await renderTrace(props)
  try {
    await app.mockMouse.drag(4, 0, 40, 0)
    await app.renderOnce()
    expect(props.view.win()).toBeDefined()
    const win = props.view.win()!
    expect(win.b).toBeGreaterThan(win.a)

    // Two quick clicks on the overview (a double click) reset the zoom.
    await app.mockMouse.click(40, 0)
    await app.mockMouse.click(40, 0)
    await app.renderOnce()
    expect(props.view.win()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("the wheel over the lens scrolls the panel under the pointer", async () => {
  const props = traceProps(undefined)
  const app = await renderTrace(props)
  try {
    await app.mockMouse.scroll(20, 12, "down")
    await app.renderOnce()
    expect(props.scrolled.length).toBeGreaterThan(0)
    expect(props.scrolled[0]).toBeGreaterThan(0)
    await app.mockMouse.scroll(20, 12, "up")
    await app.renderOnce()
    expect(props.scrolled.at(-1)).toBeLessThan(0)
  } finally {
    app.renderer.destroy()
  }
})
