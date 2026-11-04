/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { Understory } from "../src/components/understory"
import { CellGridRenderable } from "../src/components/understory/cells"
import { buildGraphData } from "../src/components/understory/graph-data"
import { Inspector, type InspectorProps } from "../src/components/understory/inspector"
import { rowGeometry, understoryColumns } from "../src/components/understory/layout"
import { rowColor, rowGlyph } from "../src/components/understory/roster"
import type { AgentSpan, StaleEdit } from "../src/data/understory-spans"
import { rosterRows, type AgentSheet, type RosterRow } from "../src/data/understory"
import { palette } from "../src/theme"
import { mount } from "./harness"
import { clickRegion, LENS_TABS, ROSTER } from "./fixture/click"
import { fakeTimers, understoryFixture, type UnderstorySpec } from "./fixture/understory"

const spec = (input: Partial<UnderstorySpec> & { readonly id: string }): UnderstorySpec => ({
  agent: "explore",
  title: `task ${input.id}`,
  state: "done",
  ...input,
})

const CHILD_TASK = "rewrite the fallback resolver"

/** `agents` branches under one root: enough to force each lane height at 168x48. */
function many(agents: number): readonly UnderstorySpec[] {
  return [
    spec({ id: "ses_first", agent: "coder", title: CHILD_TASK, state: "running", tokens: 8_000, cost: 0.04, created: 1_100 }),
    ...Array.from({ length: Math.max(0, agents - 1) }, (_, index) =>
      spec({ id: `ses_m${index}`, agent: "explore", title: `task ${index}`, tokens: 1_000, created: 1_200 + index }),
    ),
  ]
}

async function render(fixture: ReturnType<typeof understoryFixture>, width: number, height: number) {
  const clock = fakeTimers()
  const app = await mount(
    () => (
      <Understory
        context={fixture.context}
        sessionID="ses_root"
        mesh={fixture.mesh}
        timers={{ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }}
        now={clock.now}
      />
    ),
    { width, height },
  )
  await app.renderOnce()
  await app.renderOnce()
  return app
}

function rosterLines(frame: string, width: number): string[] {
  return frame.split("\n").map((line) => line.slice(0, width))
}

/** The same rows the shell builds, for a test that needs labels and states. */
function rowsOf(fixture: ReturnType<typeof understoryFixture>) {
  return rosterRows({
    root: "ses_root",
    sessions: fixture.sessions,
    mesh: fixture.mesh.root("ses_root"),
    killed: fixture.mesh.killed(),
    messages: (sessionID) => [...(fixture.messages[sessionID] ?? [])],
  })
}

function rosterGrid(app: Awaited<ReturnType<typeof mount>>): CellGridRenderable {
  return app.renderer.root.findDescendantById("banyancode.understory.roster") as unknown as CellGridRenderable
}

const plainRow = (input: Partial<RosterRow> = {}): RosterRow => ({
  sessionID: "ses_one",
  depth: 1,
  agent: "coder",
  label: "coder-1",
  state: "running",
  pending: 0,
  tokens: 32_200,
  cost: 0,
  startedAt: 1_000,
  historyMayBeTruncated: false,
  hasChildren: false,
  ...input,
})

const plainSheet = (input: Partial<AgentSheet> = {}): AgentSheet => ({
  sessionID: "ses_one",
  label: "coder-1",
  agent: "coder",
  state: "running",
  pending: 0,
  output: [],
  tools: [],
  files: [],
  tokens: 32_200,
  historyMayBeTruncated: false,
  ...input,
})

async function renderInspector(overrides: Partial<InspectorProps> = {}) {
  const fixture = understoryFixture()
  const theme = palette(fixture.context.theme)
  const props: InspectorProps = {
    width: 44,
    height: 40,
    row: plainRow(),
    hue: theme.leaf,
    glyph: "⋯",
    glyphColor: theme.leaf,
    ask: undefined,
    sheet: plainSheet(),
    run: undefined,
    hues: new Map(),
    theme,
    animations: false,
    tick: 0,
    now: () => 10_000,
    actions: [
      { id: "steer", label: "steer", run: () => {} },
      { id: "kill", label: "kill", run: () => {} },
      { id: "open", label: "open session", run: () => {} },
    ],
    onAnswer: () => {},
    onOpenSession: () => {},
    file: undefined,
    graph: undefined,
    pinned: undefined,
    spans: new Map(),
    stale: [],
    touches: () => [],
    rate: () => 0,
  }
  const app = await mount(() => <Inspector {...props} {...overrides} />, { width: props.width, height: props.height })
  await app.renderOnce()
  return app
}

test("each lane height draws exactly that many rows, and the row content follows the brief", async () => {
  const cases = [
    { agents: 6, lane: 4 },
    { agents: 11, lane: 3 },
    { agents: 16, lane: 2 },
    { agents: 22, lane: 1 },
  ] as const

  for (const item of cases) {
    const fixture = understoryFixture({ specs: many(item.agents), limit: 20, root: { tokens: 9_000, cost: 0 } })
    const app = await render(fixture, 168, 48)
    try {
      expect(rowGeometry(48, item.agents + 1).laneHeight).toBe(item.lane)
      const roster = rosterLines(app.captureCharFrame(), understoryColumns(168).roster).join("\n")
      const rootLine = roster.split("\n").findIndex((line) => line.includes("build"))
      const childLine = roster.split("\n").findIndex((line) => line.includes("coder"))
      expect(rootLine).toBeGreaterThan(-1)
      expect(childLine).toBeGreaterThan(rootLine)
      expect(childLine - rootLine).toBe(item.lane)

      // 4 rows: name, task, tokens + cost. 3 rows: name, task. 2 rows: name, task.
      expect(roster).toContain(CHILD_TASK.slice(0, 12))
      if (item.lane >= 4) expect(roster).toContain("8.0k")
      if (item.lane === 3) expect(roster).not.toContain("8.0k")
      if (item.lane === 1) expect(roster).toContain("8.0k")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("the header carries the branch limit, the run clock and the state chips", async () => {
  const fixture = understoryFixture({
    specs: [
      spec({ id: "ses_run", agent: "coder", title: "running", state: "running" }),
      spec({ id: "ses_wait", agent: "coder", title: "waiting", state: "waiting", pending: 1 }),
      spec({ id: "ses_fail", agent: "scout", title: "failed", state: "failed" }),
      spec({ id: "ses_kill", agent: "scout", title: "killed", state: "killed", killed: true }),
      spec({ id: "ses_done", agent: "explore", title: "done" }),
    ],
    limit: 20,
  })
  const app = await render(fixture, 168, 48)
  try {
    const header = rosterLines(app.captureCharFrame(), 34).slice(0, 4).join("\n")
    expect(header).toContain("BRANCHES 5/20")
    expect(header).toContain("RUN 0:11")
    expect(header).toContain("running")
    expect(header).toContain("⣿1")
    expect(header).toContain("▲1")
    expect(header).toContain("✕2")
    expect(header).toContain("✓1")
    expect(header).not.toContain("⊘")
    expect(header.indexOf("⣿1")).toBeLessThan(header.indexOf("▲1"))
    expect(header.indexOf("▲1")).toBeLessThan(header.indexOf("✕2"))
    expect(header.indexOf("✕2")).toBeLessThan(header.indexOf("✓1"))
  } finally {
    app.renderer.destroy()
  }
})

test("the limit is omitted when the mesh has not loaded one", async () => {
  const app = await render(understoryFixture({ specs: [spec({ id: "ses_a" })] }), 168, 48)
  try {
    const header = rosterLines(app.captureCharFrame(), 34)[0] ?? ""
    expect(header).toContain("BRANCHES 1")
    expect(header).not.toContain("1/")
  } finally {
    app.renderer.destroy()
  }
})

test("cost is hidden at exactly zero and drawn when it is real", async () => {
  const free = await render(
    understoryFixture({ specs: [spec({ id: "ses_free", tokens: 2_000, cost: 0 })], root: { tokens: 1_000, cost: 0 } }),
    168,
    48,
  )
  try {
    const roster = rosterLines(free.captureCharFrame(), understoryColumns(168).roster).join("\n")
    expect(roster).not.toContain("$0.00")
    expect(roster).not.toContain("$")
  } finally {
    free.renderer.destroy()
  }

  const paid = await render(
    understoryFixture({ specs: [spec({ id: "ses_paid", tokens: 2_000, cost: 0.04 })] }),
    168,
    48,
  )
  try {
    expect(rosterLines(paid.captureCharFrame(), understoryColumns(168).roster).join("\n")).toContain("$0.04")
  } finally {
    paid.renderer.destroy()
  }
})

test("failed and killed never look finished: different glyphs, different colours", async () => {
  const fixture = understoryFixture({
    specs: [
      spec({ id: "ses_done", agent: "explore", title: "done", state: "done" }),
      spec({ id: "ses_failed", agent: "general", title: "failed", state: "failed" }),
      spec({ id: "ses_killed", agent: "scout", title: "killed", state: "killed", killed: true }),
    ],
  })
  const app = await render(fixture, 168, 48)
  try {
    const base = palette(fixture.context.theme)
    const colors = {
      done: RGBA.fromInts(1, 2, 3, 255),
      error: RGBA.fromInts(4, 5, 6, 255),
      warning: RGBA.fromInts(7, 8, 9, 255),
      border: RGBA.fromInts(10, 11, 12, 255),
      leaf: RGBA.fromInts(13, 14, 15, 255),
    }
    const theme = { ...base, ...colors }
    const rows = rowsOf(fixture)
    const done = rows.find((row) => row.agent === "explore")!
    const failed = rows.find((row) => row.agent === "general")!
    const killed = rows.find((row) => row.agent === "scout")!
    expect(done.state).toBe("done")
    expect(failed.state).toBe("failed")
    expect(killed.state).toBe("killed")
    expect(rowGlyph(done, 0, 0, false)).toBe("✓")
    expect(rowGlyph(failed, 0, 0, false)).toBe("✕")
    expect(rowGlyph(killed, 0, 0, false)).toBe("⊘")
    expect(rowColor(done, theme, 0, false)).toEqual(colors.done)
    expect(rowColor(failed, theme, 0, false)).toEqual(colors.error)
    expect(rowColor(killed, theme, 0, false)).toEqual(colors.error)
    expect(rowColor(failed, theme, 0, false)).not.toEqual(rowColor(done, theme, 0, false))

    const grid = rosterGrid(app)
    const found = new Map<string, string>()
    const lines = grid.grid.lines()
    const agents: ReadonlyArray<readonly [string, string]> = [
      ["done", "explore"],
      ["failed", "general"],
      ["killed", "scout"],
    ]
    for (let y = 0; y < lines.length; y += 1) {
      for (const [state, agent] of agents) {
        const column = (lines[y] ?? "").lastIndexOf(` ${agent}`)
        if (column < 1) continue
        const cell = grid.grid.cell(column - 1, y)
        if (cell !== undefined) found.set(state, cell.glyph)
      }
    }
    expect(found.get("done")).toBe("✓")
    expect(found.get("failed")).toBe("✕")
    expect(found.get("killed")).toBe("⊘")
  } finally {
    app.renderer.destroy()
  }
})

test("a shortened label keeps its number, and the selected row carries the leaf bar", async () => {
  const specs = Array.from({ length: 20 }, (_, index) =>
    spec({
      id: `ses_${index}`,
      agent: ["explore", "coder", "scout"][index % 3]!,
      title: `task ${index}`,
      state: index % 4 === 0 ? "running" : "done",
      created: 1_000 + index,
    }),
  )
  const fixture = understoryFixture({ specs })
  const app = await render(fixture, 80, 24)
  try {
    const roster = rosterLines(app.captureCharFrame(), 12).join("\n")
    expect(roster).toMatch(/expl…-\d/)
    expect(roster).toContain("▌")
  } finally {
    app.renderer.destroy()
  }
})

test("a stale edit shows on both agents' sheets and clears when the reader re-reads", async () => {
  const file = "postinstall.mjs"
  const fixture = understoryFixture({
    specs: [
      spec({ id: "ses_writer", agent: "coder", title: "writer", state: "running", created: 1_000 }),
      spec({ id: "ses_reader", agent: "coder", title: "reader", state: "running", created: 1_050 }),
    ],
  })
  const tool = (id: string, name: string, at: number): SessionMessageInfo =>
    ({
      id,
      type: "assistant",
      time: { created: at, completed: at + 10 },
      content: [
        {
          type: "tool",
          id: `${id}_part`,
          name,
          state: { status: "completed", input: { filePath: file }, content: [], metadata: {} },
          time: { created: at, completed: at + 10 },
        },
      ],
    }) as unknown as SessionMessageInfo
  // The reader reads, the writer reads and edits, then the reader edits without
  // reading again: the reader is working from a stale read.
  fixture.append("ses_reader", tool("r_read", "read", 2_000))
  fixture.append("ses_writer", tool("w_read", "read", 2_100))
  fixture.append("ses_writer", tool("w_edit", "edit", 3_000))
  fixture.append("ses_reader", tool("r_edit", "edit", 4_000))

  const app = await render(fixture, 168, 48)
  try {
    clickRegion(app, ROSTER, "row:ses_writer")
    await app.renderOnce()
    expect(rowsOf(fixture)[1]?.label).toBe("coder-1")
    const first = app.captureCharFrame()
    expect(first).toContain("STALE EDIT")
    expect(first).toContain("steer coder-2")

    clickRegion(app, ROSTER, "row:ses_reader")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("STALE EDIT")
    expect(app.captureCharFrame()).toContain("steer coder-1")

    fixture.append("ses_reader", tool("r_reread", "read", 20_000))
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("STALE EDIT")
  } finally {
    app.renderer.destroy()
  }
})

test("the File sheet reads its tile, and says when the graph is not built", async () => {
  const path = "packages/cli/postinstall.mjs"
  const graph = buildGraphData({
    files: [
      { id: "f1", path, contentHash: "", language: "javascript", indexedAt: 0 },
      { id: "f2", path: "packages/cli/index.mjs", contentHash: "", language: "javascript", indexedAt: 0 },
    ],
    nodes: [
      { id: "n1", fileID: "f1", kind: "function", name: "resolve", startLine: 1, endLine: 120 },
      { id: "n2", fileID: "f2", kind: "function", name: "main", startLine: 1, endLine: 40 },
    ],
    edges: [{ id: "e1", fromNodeID: "n2", toNodeID: "n1", kind: "import" }],
  })

  const withGraph = await renderInspector({
    file: path,
    graph,
    row: plainRow({ sessionID: "ses_writer", label: "coder-1" }),
    touches: () => [
      {
        at: 2_500,
        label: "coder-1",
        sessionID: "ses_writer",
        verb: "w",
        summary: "edit postinstall.mjs",
        added: 6,
        removed: 1,
      },
    ],
  })
  try {
    const frame = withGraph.captureCharFrame()
    expect(frame).toContain("FILE")
    expect(frame).toContain("postinstall.mjs")
    expect(frame).toContain("120 lines")
    expect(frame).toContain("BLAST RADIUS")
    expect(frame).toContain("1 direct")
    expect(frame).toContain("TOUCHES 1")
    expect(frame).toContain("edit +6 −1")
    expect(frame).toContain("DEPENDENTS")
    expect(frame).toContain("index.mjs")
  } finally {
    withGraph.renderer.destroy()
  }

  const bare = await renderInspector({ file: path, graph: undefined })
  try {
    const frame = bare.captureCharFrame()
    expect(frame).toContain("FILE")
    expect(frame).toContain("Graph not built.")
    expect(frame).toContain("/codegraph-build")
    expect(frame).not.toContain("BLAST RADIUS")
  } finally {
    bare.renderer.destroy()
  }
})

test("the ask box's right border lines up at every width, and every answer is a button", async () => {
  for (const width of [44, 34, 28]) {
    const app = await renderInspector({
      width,
      ask: { kind: "permission", title: "bash", target: "npm pack --dry-run" },
    })
    try {
      const lines = app.captureCharFrame().split("\n")
      const start = lines.findIndex((line) => line.includes("NEEDS YOU") && line.includes("╭"))
      expect(start).toBeGreaterThanOrEqual(0)
      // Top border, the ask, the bottom border: three rows of one width, so the
      // right edge lands on one column for all of them.
      const box = lines.slice(start, start + 3).map((line) => Array.from(line.trimEnd()))
      expect(new Set(box.map((cells) => cells.length)).size).toBe(1)
      expect(lines[start + 1]).toContain("bash")
      for (const cells of box.slice(1, 2)) expect(cells[cells.length - 1]).toBe("│")
      // The answers sit on their own row as buttons, not as key hints.
      const answers = lines[start + 3]!
      expect(answers).toContain("allow")
      expect(answers).toContain("always")
      expect(answers).toContain("deny")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("the Call sheet shows the pinned call's timing, change and output", async () => {
  const span: AgentSpan = {
    id: "m1:0",
    kind: "tool",
    t0: 2_000,
    t1: 4_900,
    letter: "E",
    name: "edit",
    target: "postinstall.mjs",
    file: "packages/cli/postinstall.mjs",
    added: 6,
    removed: 1,
    output: "patched the resolver",
  }
  const app = await renderInspector({
    pinned: { sessionID: "ses_one", spanID: "m1:0" },
    spans: new Map([["ses_one", [span]]]),
  })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("CALL")
    expect(frame).toContain("‹ coder-1")
    expect(frame).toContain("edit")
    expect(frame).toContain("TIMING")
    expect(frame).toContain("created 0:02")
    expect(frame).toContain("took 2.9s")
    expect(frame).toContain("CHANGE")
    expect(frame).toContain("+6")
    expect(frame).toContain("−1")
    expect(frame).toContain("OUTPUT")
    expect(frame).toContain("patched the resolver")
  } finally {
    app.renderer.destroy()
  }
})

test("the Agent sheet hides sections it has no data for and keeps the action row last", async () => {
  const bare = await renderInspector()
  try {
    const frame = bare.captureCharFrame()
    expect(frame).toContain("BRANCH")
    expect(frame).toContain("TOKENS")
    expect(frame).not.toContain("OUTPUT")
    expect(frame).not.toContain("TOOLS")
    expect(frame).not.toContain("CHANGED")
    expect(frame).not.toContain("STALE EDIT")
    expect(frame).toContain("steer")
    expect(frame).toContain("kill")
    expect(frame).toContain("open session")
    const lines = frame.replace(/\n$/, "").split("\n")
    const action = lines.findIndex((line) => line.includes("open session"))
    expect(action).toBe(lines.length - 1)
  } finally {
    bare.renderer.destroy()
  }
})

test("the Agent sheet stacks the tool kinds and lists the newest calls", async () => {
  const sheet = plainSheet({
    output: ["the fallback still resolves the wrong tarball"],
    tools: [
      { name: "edit", letter: "E", target: "postinstall.mjs", status: "completed", at: 3_000, durationMs: 2_900, error: false },
      { name: "edit", letter: "E", target: "postinstall.mjs", status: "completed", at: 2_000, durationMs: 3_600, error: false },
      { name: "read", letter: "R", target: "postinstall.mjs", status: "completed", at: 1_000, durationMs: 1_400, error: false },
    ],
    files: [{ path: "packages/cli/postinstall.mjs", added: 6, removed: 1 }],
  })
  const app = await renderInspector({ sheet, stale: [] as readonly StaleEdit[] })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("OUTPUT")
    expect(frame).toContain("the fallback still resolves")
    expect(frame).toContain("TOOLS 3")
    expect(frame).toContain("1 read")
    expect(frame).toContain("2 edit")
    expect(frame).toContain("✓ edit postinstall.mjs")
    expect(frame).toContain("CHANGED 1")
    expect(frame).toContain("+6")
    expect(frame).toContain("32.2k")
  } finally {
    app.renderer.destroy()
  }
})

test("animations off draws the inspector overlay without a spring timer", async () => {
  const fixture = understoryFixture({ specs: many(2), animations: false })
  const app = await render(fixture, 120, 40)
  try {
    expect(await clickRegion(app, LENS_TABS, "lens:details")).toBe(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("TOKENS BY BRANCH")
  } finally {
    app.renderer.destroy()
  }
})
