/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { CellGridRenderable, Grid } from "../src/components/understory/cells"
import { branchHue } from "../src/components/understory/hue"
import { rowGeometry, rosterAreaRows, TRACE_SCALE_MAX, understoryColumns } from "../src/components/understory/layout"
import { TraceLens } from "../src/components/understory/trace"
import { drawLane, drawOverview, drawSpawnLinks, laneRows, traceLayout } from "../src/components/understory/trace/draw"
import { createUnderstoryView, type LensProps } from "../src/components/understory/view"
import { rosterRows, type RosterRow, type ToolLetter } from "../src/data/understory"
import type { AgentSpan } from "../src/data/understory-spans"
import { mix } from "../src/motion"
import { palette, type Palette } from "../src/theme"
import { mount, theme as harnessTheme } from "./harness"
import { understoryFixture, type UnderstorySpec } from "./fixture/understory"

/** The mockup's chrome: a 48-row terminal leaves 38 rows for the panel. */
const CHROME = 10
const T0 = 1_700_000_000_000
const at = (seconds: number) => T0 + seconds * 1000

const GREY = RGBA.fromInts(120, 120, 120)
const GROUND = RGBA.fromInts(10, 14, 11)
const SELECTED = RGBA.fromInts(30, 44, 33)
const SKY = RGBA.fromInts(140, 196, 232)
const SEARCH = RGBA.fromInts(159, 192, 199)
const EDIT = RGBA.fromInts(127, 214, 138)
const SHELL = RGBA.fromInts(169, 130, 87)
const VERIFY = RGBA.fromInts(200, 242, 124)
const WEB = RGBA.fromInts(185, 162, 232)
const AMBER = RGBA.fromInts(232, 177, 90)
const CORAL = RGBA.fromInts(238, 132, 120)
const MOSS = RGBA.fromInts(75, 138, 88)
const LIME = RGBA.fromInts(200, 255, 120)
const WOOD = RGBA.fromInts(66, 84, 74)

/** Distinct colours, so a cell's role reads from its exact RGBA. */
const DISTINCT: Palette = palette({
  ...harnessTheme,
  background: { base: GROUND, raised: { base: GROUND, high: SELECTED, max: GROUND } },
  growth: { leaf: EDIT, highlight: EDIT, done: MOSS, faded: GREY, wood: WOOD, bright: LIME },
  tool: { read: SKY, search: SEARCH, edit: EDIT, shell: SHELL, verify: VERIFY, web: WEB },
  text: {
    ...harnessTheme.text,
    base: GREY,
    muted: GREY,
    faint: GREY,
    feedback: {
      error: { base: CORAL, muted: CORAL },
      warning: { base: AMBER, muted: AMBER },
      success: { base: MOSS, muted: MOSS },
      info: { base: SKY, muted: SKY },
    },
  },
  border: { base: WOOD },
} as unknown as ResolvedTheme)

interface Scenario {
  readonly fixture: ReturnType<typeof understoryFixture>
  readonly rows: RosterRow[]
  readonly spans: ReadonlyMap<string, readonly AgentSpan[]>
}

const SPECS: readonly UnderstorySpec[] = [
  { id: "ses_c1", agent: "coder", title: "Add version check", state: "running", tokens: 32_200, created: at(2) },
  {
    id: "ses_c2",
    agent: "coder",
    title: "Check registry metadata",
    state: "waiting",
    pending: 1,
    tokens: 24_100,
    created: at(4),
  },
  { id: "ses_e1", agent: "explore", title: "Trace the resolver", state: "done", tokens: 14_200, created: at(1.5), idle: at(14) },
  { id: "ses_e2", agent: "explore", title: "Find the readers", state: "done", tokens: 15_100, created: at(3), idle: at(15) },
  { id: "ses_s1", agent: "scout", title: "Smoke the Windows build", state: "failed", tokens: 12_000, created: at(5), idle: at(30) },
  { id: "ses_r1", agent: "researcher", title: "How npm hoists", state: "done", tokens: 22_400, created: at(6), idle: at(22) },
  { id: "ses_c3", agent: "coder", title: "Route the updater", state: "killed", killed: true, tokens: 8_000, created: at(7), idle: at(35) },
  { id: "ses_s2", agent: "scout", title: "Probe the shim", state: "done", tokens: 4_400, created: at(8), idle: at(20) },
]

function tool(
  id: string,
  letter: ToolLetter,
  from: number,
  to: number | undefined,
  name: string,
  target: string,
  extra: { readonly error?: string; readonly file?: string } = {},
): AgentSpan {
  return {
    id,
    kind: "tool",
    t0: at(from),
    ...(to === undefined ? {} : { t1: at(to) }),
    letter,
    name,
    target,
    ...(extra.file === undefined ? {} : { file: extra.file }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
  }
}

function buildScenario(options: { readonly truncated?: boolean } = {}): Scenario {
  const specs = SPECS.map((spec) => (options.truncated === true && spec.id === "ses_c1" ? { ...spec, truncated: true } : spec))
  const fixture = understoryFixture({ root: { created: T0 }, specs })
  const rows = rosterRows({
    root: "ses_root",
    sessions: fixture.sessions,
    mesh: fixture.mesh.root("ses_root"),
    killed: new Set(specs.filter((spec) => spec.killed === true).map((spec) => spec.id)),
    pending: (sessionID) => specs.find((spec) => spec.id === sessionID)?.pending ?? 0,
    status: () => "idle",
    messages: (sessionID) => fixture.messages[sessionID] ?? [],
  })
  const spans = new Map<string, readonly AgentSpan[]>([
    ["ses_root", [{ id: "root:wait", kind: "wait", t0: at(8), letter: "?", name: "waiting", target: "" }]],
    [
      "ses_c1",
      [
        tool("c1:read", "R", 13, 14.4, "read", "postinstall.mjs", { file: "packages/cli/script/postinstall.mjs" }),
        tool("c1:edit", "E", 15, 17.9, "edit", "postinstall.mjs", { file: "packages/cli/script/postinstall.mjs" }),
        tool("c1:grep", "S", 26, 27.4, "grep", "resolveBinary"),
        tool("c1:shell", "$", 36, 38.4, "shell", "npm pack --dry-run"),
        tool("c1:open", "$", 41, undefined, "shell", "npm pack --dry-run"),
      ],
    ],
    [
      "ses_c2",
      [
        tool("c2:edit", "E", 12, 13.6, "edit", "postinstall.mjs"),
        { id: "c2:ask", kind: "ask", t0: at(38), letter: "?", name: "ask", target: "shell: npm pack --dry-run" },
      ],
    ],
    ["ses_e1", [tool("e1:read", "R", 5, 6.5, "read", "postinstall.mjs")]],
    ["ses_e2", [tool("e2:grep", "S", 3, 4.2, "grep", "platform")]],
    [
      "ses_s1",
      [
        tool("s1:web", "W", 9, 11, "websearch", "npm optional deps"),
        tool("s1:fail", "$", 28, 29.5, "shell", "banyancode.exe --version", { error: "exit 1" }),
      ],
    ],
    ["ses_r1", [tool("r1:verify", "V", 16, 18, "banyan_test", "installer.test.ts")]],
    ["ses_c3", [tool("c3:read", "R", 20, 21, "read", "updater.ts")]],
    ["ses_s2", [tool("s2:web", "W", 12, 13, "webfetch", "docs.npmjs.com")]],
  ])
  return { fixture, rows, spans }
}

function lensProps(input: {
  readonly scenario: Scenario
  readonly size: { readonly width: number; readonly height: number }
  readonly now: number
  readonly selected?: string
  readonly offset?: number
  readonly zoom?: 1 | -1
  readonly animations?: boolean
  readonly tick?: number
  readonly theme?: Palette
  readonly on?: Partial<LensProps["on"]>
  readonly rows?: readonly RosterRow[]
  readonly spans?: ReadonlyMap<string, readonly AgentSpan[]>
  readonly messages?: (sessionID: string) => readonly SessionMessageInfo[]
}): LensProps {
  const rows = input.rows ?? input.scenario.rows
  const cols = understoryColumns(input.size.width)
  const panel = Math.max(2, input.size.height - CHROME)
  const geometry = rowGeometry(panel, rows.length)
  const view = createUnderstoryView({ now: () => input.now })
  if (input.zoom !== undefined) view.zoom(input.zoom)
  const theme = input.theme ?? palette(harnessTheme)
  return {
    rows,
    visible: rows,
    offset: input.offset ?? 0,
    ask: (sessionID) => input.scenario.spans.get(sessionID)?.find((span) => span.kind === "ask")?.target,
    spans: input.spans ?? input.scenario.spans,
    messages: input.messages ?? (() => []),
    hues: new Map(rows.map((row, index) => [row.sessionID, branchHue(index, "dark") as RGBA])),
    theme,
    view,
    selected: input.selected ?? rows[1]?.sessionID,
    width: cols.stream,
    height: panel - 2,
    geometry,
    animations: input.animations ?? false,
    tick: input.tick ?? 0,
    on: {
      selectAgent: input.on?.selectAgent ?? (() => {}),
      pinCall: input.on?.pinCall ?? (() => {}),
      selectFile: input.on?.selectFile ?? (() => {}),
    },
  }
}

async function render(props: LensProps) {
  const app = await mount(() => <TraceLens {...props} />, { width: props.width, height: props.height })
  await app.renderOnce()
  await app.renderOnce()
  return app
}

const SIZE = { width: 168, height: 48 } as const

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test("the now column takes a third and every lane lands on its roster row at all five sizes", async () => {
  const sizes = [
    [200, 55],
    [168, 48],
    [120, 40],
    [100, 30],
    [80, 24],
  ] as const
  const scenario = buildScenario()
  const lanes: number[] = []
  for (const [width, height] of sizes) {
    const props = lensProps({ scenario, size: { width, height }, now: at(46) })
    // The roster and the lens read one row map: the header (tabs, overview,
    // ruler) is where the roster's own header ends and its first entry starts.
    expect(props.geometry.header).toBe(1 + props.geometry.overview + props.geometry.ruler)
    expect(rosterAreaRows(height - CHROME)).toBe(props.geometry.lanesArea)
    expect(traceLayout(props.width).x + traceLayout(props.width).history).toBeLessThanOrEqual(props.width)

    const app = await render(props)
    try {
      const lines = app.captureCharFrame().split("\n")
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(props.width)
      const out = traceLayout(props.width)
      const top = props.geometry.overview + props.geometry.ruler
      const band = laneRows(props.geometry.laneHeight)
      // Each row's now line is unique; it must start on that lane's block row.
      scenario.rows.forEach((row, index) => {
        if (row.sessionID !== "ses_c1") return
        const expected = top + index * props.geometry.laneHeight + band.block
        const found = lines.findIndex((line) => line.slice(out.labelX).includes("npm pack"))
        expect(found).toBe(expected)
      })
      lanes.push(props.geometry.laneHeight)
    } finally {
      app.renderer.destroy()
    }
  }
  // The adaptive rule the reference frames pin: 4, 3, 2, 1, 1.
  expect(lanes).toEqual([4, 3, 2, 1, 1])
})

test("the layout keeps one blank column at each edge and never inverts", () => {
  for (const width of [200, 168, 120, 100, 80, 60, 40, 20]) {
    const out = traceLayout(width)
    expect(out.x).toBe(1)
    expect(out.history).toBeGreaterThanOrEqual(1)
    expect(out.labelX).toBe(out.x + out.history + 1)
    expect(out.labelX + out.label).toBeLessThanOrEqual(width)
  }
})

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

function laneGrid(span: readonly AgentSpan[], options: { readonly height?: number; readonly animations?: boolean; readonly tick?: number; readonly width?: number } = {}) {
  const width = options.width ?? 80
  const out = traceLayout(width)
  const grid = new Grid(width, 8)
  grid.clear(GROUND)
  const height = options.height ?? 3
  const window = { a: at(0), b: at(60), scale: 1 }
  const row: RosterRow = {
    sessionID: "ses_row",
    depth: 1,
    agent: "coder",
    label: "coder-1",
    state: "running",
    pending: 0,
    tokens: 4_200,
    cost: 0,
    startedAt: at(0),
    historyMayBeTruncated: false,
    hasChildren: false,
  }
  drawLane(grid, {
    row,
    spans: span,
    messages: [],
    y: 0,
    height,
    layout: out,
    window,
    theme: DISTINCT,
    hue: SKY,
    selected: true,
    animations: options.animations ?? false,
    tick: options.tick ?? 0,
    at: at(50),
    now: at(50),
    live: true,
    pinned: undefined,
    waitingOn: 0,
  })
  return { grid, out, block: laneRows(height).block }
}

test("every tool block carries its letter, and a wide block names the tool and target", () => {
  const { grid } = laneGrid([
    tool("read", "R", 1, 3, "read", "postinstall.mjs"),
    tool("grep", "S", 4, 5, "grep", "resolve"),
    tool("edit", "E", 7, 31, "edit", "util.ts"),
    tool("shell", "$", 33, 40, "shell", "npm pack"),
    tool("verify", "V", 41, 45, "banyan_test", "installer.test.ts"),
    tool("web", "W", 46, 50, "websearch", "npm hoisting"),
    tool("task", "T", 51, 54, "subagent", "explore"),
  ])
  const found = grid
    .lines()
    .join("")
    .match(/[RSE$VWT!]/g)
  expect(found).toEqual(["R", "S", "E", "$", "V", "W", "T"])
  // The wide edit block prints its tool and short target.
  expect(grid.lines().join("\n")).toContain("edit util.ts")
})

test("a failed call is coral with a bang while a done call keeps its kind", () => {
  const { grid, out, block: row } = laneGrid([
    tool("edit", "E", 2, 8, "edit", "util.ts"),
    tool("fail", "E", 12, 18, "edit", "broken.ts", { error: "permission denied" }),
  ])
  const good = grid.cell(out.x + 3, row)!
  const bad = grid.cell(out.x + 12, row)!
  expect(good.bg.equals(EDIT)).toBe(true)
  const goodLetter = grid.cell(out.x + 2, row)!
  expect(goodLetter.glyph).toBe("E")
  expect(goodLetter.fg.equals(DISTINCT.background)).toBe(true)
  const badLetter = grid.cell(out.x + 11, row)!
  expect(badLetter.glyph).toBe("!")
  expect(badLetter.fg.equals(DISTINCT.background)).toBe(true)
  expect(bad.bg.equals(CORAL)).toBe(true)
  expect(grid.lines().join("")).not.toContain("Ebroken")
})

test("two spans that meet inside one cell split it at eighth precision", () => {
  // A second span starts 0.35 s into a cell: the shared cell carries both.
  const { grid, out, block: row } = laneGrid([tool("a", "R", 5, 10.35, "read", "a.ts"), tool("b", "E", 10.35, 14, "edit", "b.ts")])
  const cells = Array.from({ length: out.history }, (_, index) => grid.cell(out.x + index, row)!)
  const split = cells.filter((cell) => cell.bg.equals(EDIT) && cell.fg.equals(SKY) && cell.glyph !== " ")
  expect(split.length).toBeGreaterThan(0)
  expect(split[0]!.glyph).toMatch(/[▏▎▍▌▋▊▉]/)
})

test("an open call ends on a lime edge only while it animates", () => {
  const open = [tool("open", "$", 10, undefined, "shell", "npm pack")]
  const still = laneGrid(open, { animations: false })
  const moving = laneGrid(open, { animations: true, tick: 0.4 })
  // The open block reaches the playhead; its last cell is where the edge lands.
  const edge = Math.floor(((at(50) - at(0)) / (at(60) - at(0))) * still.out.history)
  expect(still.grid.cell(still.out.x + edge, still.block)!.fg.equals(DISTINCT.lime)).toBe(false)
  expect(moving.grid.cell(moving.out.x + edge, moving.block)!.fg.equals(DISTINCT.lime)).toBe(true)
})

test("an ask hatches amber, breathes only when animated, and a retry hatches dimmer", () => {
  const ask: AgentSpan = { id: "ask", kind: "ask", t0: at(20), letter: "?", name: "ask", target: "shell: npm pack" }
  const flat = laneGrid([ask], { animations: false })
  const breathing = laneGrid([ask], { animations: true, tick: 0.25 })
  const hatch = flat.grid.cell(flat.out.x + 29, flat.block)!
  expect(hatch.glyph).toBe("▒")
  expect(hatch.fg.equals(AMBER)).toBe(true)
  const breathed = breathing.grid.cell(breathing.out.x + 29, breathing.block)!
  expect(breathed.fg.equals(AMBER)).toBe(false)
  expect(breathing.grid.cell(breathing.out.x + 18, breathing.block)!.glyph).toBe("?")

  const retry = laneGrid([{ id: "retry", kind: "retry", t0: at(20), letter: "?", name: "retry", target: "attempt 2" }])
  expect(retry.grid.cell(retry.out.x + 29, retry.block)!.glyph).toBe("░")
  expect(retry.grid.cell(retry.out.x + 29, retry.block)!.fg.equals(mix(AMBER, DISTINCT.surfaceHigh, 0.5))).toBe(true)
})

test("a blocked row draws a dashed line, and finished rows stop with their own glyph", () => {
  const blocked = laneGrid([{ id: "wait", kind: "wait", t0: at(5), letter: "?", name: "waiting", target: "" }])
  expect(blocked.grid.lines().join("")).toContain("╌")

  const out = traceLayout(80)
  const grid = new Grid(80, 4)
  grid.clear(GROUND)
  const base: RosterRow = {
    sessionID: "ses_done",
    depth: 1,
    agent: "coder",
    label: "coder-1",
    state: "done",
    pending: 0,
    tokens: 1_000,
    cost: 0,
    startedAt: at(0),
    endedAt: at(30),
    historyMayBeTruncated: false,
    hasChildren: false,
  }
  drawLane(grid, {
    row: base,
    spans: [tool("done", "E", 10, 20, "edit", "a.ts")],
    messages: [],
    y: 0,
    height: 3,
    layout: out,
    window: { a: at(0), b: at(60), scale: 1 },
    theme: DISTINCT,
    hue: SKY,
    selected: false,
    animations: false,
    tick: 0,
    at: at(50),
    now: at(50),
    live: false,
    pinned: undefined,
    waitingOn: 0,
  })
  const done = grid.lines().join("")
  expect(done).toContain("✓")

  const failedGrid = new Grid(80, 4)
  failedGrid.clear(GROUND)
  drawLane(failedGrid, {
    row: { ...base, state: "failed" },
    spans: [tool("x", "E", 10, 20, "edit", "a.ts", { error: "no" })],
    messages: [],
    y: 0,
    height: 3,
    layout: out,
    window: { a: at(0), b: at(60), scale: 1 },
    theme: DISTINCT,
    hue: SKY,
    selected: false,
    animations: false,
    tick: 0,
    at: at(50),
    now: at(50),
    live: false,
    pinned: undefined,
    waitingOn: 0,
  })
  const failed = failedGrid.lines().join("")
  expect(failed).toContain("✕")
  expect(failed).not.toContain("✓")
})

test("a capped history marks the lane's left edge instead of moving its start", async () => {
  const scenario = buildScenario({ truncated: true })
  const props = lensProps({ scenario, size: SIZE, now: at(46) })
  const app = await render(props)
  try {
    const lines = app.captureCharFrame().split("\n")
    const out = traceLayout(props.width)
    const index = scenario.rows.findIndex((row) => row.sessionID === "ses_c1")
    const y = props.geometry.overview + props.geometry.ruler + index * props.geometry.laneHeight + laneRows(props.geometry.laneHeight).block
    expect(lines[y]!.slice(0, out.labelX)).toContain("…")
  } finally {
    app.renderer.destroy()
  }
})

test("spawn links drop from the parent lane to the child at spawn time", () => {
  const out = traceLayout(80)
  const grid = new Grid(80, 8)
  grid.clear(GROUND)
  const child: RosterRow = {
    sessionID: "ses_child",
    parentID: "ses_parent",
    depth: 1,
    agent: "explore",
    label: "explore-1",
    state: "running",
    pending: 0,
    tokens: 1_000,
    cost: 0,
    startedAt: at(10),
    historyMayBeTruncated: false,
    hasChildren: false,
  }
  const parent: RosterRow = { ...child, sessionID: "ses_parent", parentID: undefined, depth: 0, label: "build" }
  const window = { a: at(0), b: at(60), scale: 1 }
  drawSpawnLinks(grid, {
    layout: out,
    window,
    theme: DISTINCT,
    selected: "ses_child",
    player: [
      { row: parent, top: 0, block: 1 },
      { row: child, top: 3, block: 4 },
    ],
  })
  const column = out.x + Math.round((10 / 60) * out.history)
  expect(grid.cell(column, 2)!.glyph).toBe("│")
  expect(grid.cell(column, 3)!.glyph).toBe("│")
  expect(grid.cell(column, 4)!.glyph).toBe("╰")
  expect(grid.cell(column, 2)!.fg.equals(DISTINCT.leaf)).toBe(true)
})

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

test("the overview stacks agents at eighth-cell precision and dims what is not in the window", () => {
  const columns = 20
  const rates = Array.from({ length: columns }, () => [10, 5])
  const grid = new Grid(columns, 2)
  grid.clear(GROUND)
  drawOverview(grid, {
    x: 0,
    y: 0,
    width: columns,
    rows: 2,
    rates,
    colors: [SKY, EDIT],
    selected: 0,
    from: 0,
    to: 20_000,
    window: { a: 5_000, b: 15_000, scale: 1_000 },
    playhead: 20_000,
    replay: false,
    theme: DISTINCT,
  })
  // The selected agent owns the lower layer: foreground, the next layer sits above it.
  const bottom = grid.cell(10, 1)!
  const top = grid.cell(10, 0)!
  expect(bottom.glyph).toBe("█")
  expect(bottom.fg.equals(SKY)).toBe(true)
  expect(bottom.bg.equals(mix(GROUND, EDIT, 0.62))).toBe(true)
  expect(top.glyph).toBe("▃")
  expect(top.fg.equals(SKY)).toBe(true)
  // Outside the visible window the layer is mixed three-eighths toward the ground.
  const outside = grid.cell(0, 1)!
  expect(outside.fg.equals(mix(GROUND, SKY, 0.38))).toBe(true)
  expect(outside.bg.equals(mix(GROUND, mix(GROUND, EDIT, 0.62), 0.38))).toBe(true)
})

test("the overview leaves the future blank and marks the playhead when replaying", () => {
  const grid = new Grid(10, 2)
  grid.clear(GROUND)
  drawOverview(grid, {
    x: 0,
    y: 0,
    width: 10,
    rows: 2,
    rates: Array.from({ length: 10 }, () => [10]),
    colors: [SKY],
    selected: 0,
    from: 0,
    to: 10_000,
    window: { a: 0, b: 10_000, scale: 1_000 },
    playhead: 5_000,
    replay: true,
    theme: DISTINCT,
  })
  expect(grid.cell(7, 0)!.bg.equals(GROUND)).toBe(true)
  expect(grid.cell(2, 0)!.glyph).toBe("█")
  expect(grid.cell(2, 0)!.fg.equals(SKY)).toBe(true)
})

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

test("the window pages forward thirty percent only past the ninety percent mark", () => {
  const columns = 60
  const props = lensProps({ scenario: buildScenario(), size: SIZE, now: at(10) })
  const pressing = (seconds: number) => props.view.window({ start: T0, columns, now: at(seconds) })
  const at10 = pressing(10)
  const at30 = pressing(30)
  const at37 = pressing(37)
  expect(at30.a).toBe(at10.a)
  expect(at37.a).toBe(at10.a)
  const span = at10.b - at10.a
  expect(span).toBe(columns * 700)
  const paged = pressing(38)
  expect(paged.a).toBeCloseTo(at10.a + span * 0.3, 6)
})

test("an ended run fits the whole run instead of the live page", () => {
  const scenario = buildScenario()
  const props = lensProps({ scenario, size: SIZE, now: at(200) })
  const rows = scenario.rows.map((row) => ({ ...row, state: row.state === "running" ? ("done" as const) : row.state }))
  const ended = { ...props, rows, visible: rows }
  const win = ended.view.window({ start: T0, end: at(80), columns: 60, now: at(200) })
  expect(win.a).toBe(T0)
  expect(win.b).toBe(at(80))
  expect(win.scale).toBeCloseTo(80 / 60, 6)
})

// ---------------------------------------------------------------------------
// Whole lens
// ---------------------------------------------------------------------------

test("a twenty-one agent run fills one row each, never overflows, and scrolls with the roster offset", async () => {
  const fixture = understoryFixture({
    root: { created: T0 },
    specs: Array.from({ length: 21 }, (_, index): UnderstorySpec => ({
      id: `ses_fan${index}`,
      agent: index % 2 === 0 ? "explore" : "coder",
      title: `fan task ${index}`,
      state: "done",
      tokens: 1_000 + index * 100,
      created: at(index),
      idle: at(index + 5),
    })),
  })
  const rows = rosterRows({
    root: "ses_root",
    sessions: fixture.sessions,
    mesh: fixture.mesh.root("ses_root"),
    killed: new Set<string>(),
    pending: () => 0,
    status: () => "idle",
    messages: (sessionID) => fixture.messages[sessionID] ?? [],
  })
  const spans = new Map<string, readonly AgentSpan[]>(
    rows.map((row, index): [string, readonly AgentSpan[]] => [
      row.sessionID,
      index === 0
        ? []
        : [tool(`f${index}`, "R", 20 + index * 0.5, undefined, "read", `f${index}.ts`)],
    ]),
  )
  const wide = lensProps({ scenario: { fixture, rows, spans }, size: SIZE, now: at(40) })
  expect(wide.geometry.laneHeight).toBe(1)
  expect(wide.geometry.overflow).toBe(false)
  const app = await render(wide)
  try {
    for (const line of app.captureCharFrame().split("\n")) expect(line.length).toBeLessThanOrEqual(wide.width)
  } finally {
    app.renderer.destroy()
  }

  const narrowSize = { width: 100, height: 24 }
  const narrow = lensProps({
    scenario: { fixture, rows, spans },
    size: narrowSize,
    now: at(40),
    offset: 10,
    selected: rows[12]?.sessionID,
  })
  const top = narrow.geometry.overview + narrow.geometry.ruler
  const scrolled = await render(narrow)
  try {
    for (const line of scrolled.captureCharFrame().split("\n")) expect(line.length).toBeLessThanOrEqual(narrow.width)
    // The lane list follows the roster's offset: row 10's call starts the panel.
    const lines = scrolled.captureCharFrame().split("\n")
    expect(lines[top]).toContain("f10.ts")
  } finally {
    scrolled.renderer.destroy()
  }
  const unscrolled = await render(
    lensProps({
      scenario: { fixture, rows, spans },
      size: narrowSize,
      now: at(40),
      offset: 0,
      selected: rows[0]?.sessionID,
    }),
  )
  try {
    const lines = unscrolled.captureCharFrame().split("\n")
    expect(lines[top]).not.toContain("f10.ts")
  } finally {
    unscrolled.renderer.destroy()
  }
})

test("nothing running renders no new frame", async () => {
  const scenario = buildScenario()
  const rows = scenario.rows.map((row) => ({ ...row, state: "idle" as const, endedAt: at(40) }))
  const props = lensProps({ scenario, size: SIZE, now: at(46), rows })
  const app = await render(props)
  try {
    const node = app.renderer.root.findDescendantById("banyancode.understory.trace") as unknown as CellGridRenderable
    expect(node).toBeDefined()
    await app.renderOnce()
    expect(node.commit()).toBe(false)
    const settled = app.captureCharFrame()
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(settled)
    expect(node.commit()).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("a waiting lane carries its ask on every row, not just the selected one", async () => {
  const scenario = buildScenario()
  const spans = new Map(scenario.spans)
  spans.set("ses_c1", [
    ...(scenario.spans.get("ses_c1") ?? []).filter((span) => span.kind === "tool"),
    { id: "c1:ask", kind: "ask", t0: at(41.5), letter: "?", name: "ask", target: "shell: npm pack --dry-run" },
  ])
  spans.set("ses_e1", [
    { id: "e1:ask", kind: "ask", t0: at(30), letter: "?", name: "ask", target: "question: Which registry?" },
  ])
  const rows = scenario.rows.map((row) =>
    row.sessionID === "ses_c1" || row.sessionID === "ses_e1" ? { ...row, state: "waiting" as const } : row,
  )
  const props = lensProps({ scenario, size: SIZE, now: at(46), rows, spans, selected: "ses_root" })
  const app = await render(props)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("shell: npm pack --dry-run")
    expect(frame).toContain("question: Which registry?")
  } finally {
    app.renderer.destroy()
  }
})

test("the empty run says where lanes will appear and how to grow them", async () => {
  const fixture = understoryFixture({ root: { created: T0, state: "idle" }, rootMessages: false })
  const rows = rosterRows({
    root: "ses_root",
    sessions: fixture.sessions,
    mesh: fixture.mesh.root("ses_root"),
    killed: new Set<string>(),
    pending: () => 0,
    status: () => "idle",
    messages: () => [],
  })
  const props = lensProps({
    scenario: { fixture, rows, spans: new Map([[rows[0]!.sessionID, []]]) },
    size: SIZE,
    now: at(0),
    rows,
  })
  const app = await render(props)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("No branches yet")
    expect(frame).toContain("Agents appear here as lanes when build fans out.")
    expect(frame).toContain("Press Tab and send a message to try it.")
    expect(frame).toContain("Send a message to grow the first branches.")
    expect(frame).toContain("NOW")
  } finally {
    app.renderer.destroy()
  }
})

test("the legend names every kind and swaps the hint when zoomed", async () => {
  const scenario = buildScenario()
  const plain = lensProps({ scenario, size: SIZE, now: at(46) })
  const app = await render(plain)
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("R read  S search  E edit  $ shell  V verify  W web")
    expect(frame).toContain("drag overview to zoom")
  } finally {
    app.renderer.destroy()
  }

  const zoomed = lensProps({ scenario, size: SIZE, now: at(46), zoom: -1 })
  expect(zoomed.view.scale()).toBe(1.4)
  expect(zoomed.view.scale()).toBeLessThanOrEqual(TRACE_SCALE_MAX)
  const zoomedApp = await render(zoomed)
  try {
    expect(zoomedApp.captureCharFrame()).toContain("0 reset zoom")
  } finally {
    zoomedApp.renderer.destroy()
  }
})

// ---------------------------------------------------------------------------
// Hits
// ---------------------------------------------------------------------------

test("clicking a lane selects it, a block pins it, and the ruler moves the playhead", async () => {
  const selected: string[] = []
  const pins: Array<{ sessionID: string; spanID: string } | undefined> = []
  const scenario = buildScenario()
  const props = lensProps({
    scenario,
    size: SIZE,
    now: at(46),
    on: {
      selectAgent: (sessionID) => selected.push(sessionID),
      pinCall: (call) => pins.push(call),
    },
  })
  const app = await render(props)
  try {
    const out = traceLayout(props.width)
    const top = props.geometry.overview + props.geometry.ruler
    const index = scenario.rows.findIndex((row) => row.sessionID === "ses_c1")
    const block = top + index * props.geometry.laneHeight + laneRows(props.geometry.laneHeight).block

    // The lane's now column selects it.
    await app.mockMouse.click(out.labelX + 2, block)
    expect(selected.at(-1)).toBe("ses_c1")

    // A block pins its call as well as selecting the lane.
    await app.mockMouse.click(2, block)
    expect(selected.at(-1)).toBe("ses_c1")
    expect(pins.at(-1)?.sessionID).toBe("ses_c1")
    expect(pins.at(-1)?.spanID).toBe("c1:read")

    // The ruler moves the playhead off live.
    expect(props.view.live()).toBe(true)
    await app.mockMouse.click(out.x + 5, props.geometry.overview)
    expect(props.view.live()).toBe(false)
    expect(props.view.t()).toBeDefined()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("AT ")
  } finally {
    app.renderer.destroy()
  }
})

// ---------------------------------------------------------------------------
// Token bars
// ---------------------------------------------------------------------------

test("token bars grow from the token signal only, and stay flat when there is none", () => {
  const messages = [
    {
      id: "m1",
      type: "assistant",
      time: { created: at(10), completed: at(30) },
      agent: "coder",
      model: { providerID: "p", id: "m" },
      tokens: { input: 1_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [],
    },
  ] as unknown as SessionMessageInfo[]
  const spansFor = [tool("t", "R", 10, 30, "read", "a.ts")]
  const withTokens = laneGridWith(messages, spansFor)
  const withoutTokens = laneGridWith([], spansFor)
  const bars = (grid: Grid) =>
    Array.from({ length: 80 }, (_, x) => grid.cell(x, 0)!).filter((cell) => /[▁▂▃▄▅▆▇█]/.test(cell.glyph))
  expect(bars(withTokens).length).toBeGreaterThan(0)
  expect(bars(withoutTokens).length).toBe(0)
})

function laneGridWith(messages: readonly SessionMessageInfo[], spans: readonly AgentSpan[]) {
  const width = 80
  const out = traceLayout(width)
  const grid = new Grid(width, 5)
  grid.clear(GROUND)
  drawLane(grid, {
    row: {
      sessionID: "ses_row",
      depth: 1,
      agent: "coder",
      label: "coder-1",
      state: "running",
      pending: 0,
      tokens: 10_000,
      cost: 0,
      startedAt: at(0),
      historyMayBeTruncated: false,
      hasChildren: false,
    },
    spans,
    messages,
    y: 0,
    height: 4,
    layout: out,
    window: { a: at(0), b: at(60), scale: 1 },
    theme: DISTINCT,
    hue: SKY,
    selected: true,
    animations: false,
    tick: 0,
    at: at(50),
    now: at(50),
    live: true,
    pinned: undefined,
    waitingOn: 0,
  })
  return grid
}
