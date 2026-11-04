/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { InspectorPanel } from "../src/components/panels/inspector"
import { Understory } from "../src/components/understory"
import { PANEL } from "../src/constants"
import { createTicker } from "../src/motion"
import { shortLabel } from "../src/data/understory"
import { rowGeometry } from "../src/components/understory/layout"
import { understoryColumns } from "../src/understory"
import { live, mount } from "./harness"
import { clickRegion, INSPECTOR_ACTIONS, INSPECTOR_ASK, LENS_TABS, ROSTER, STREAM_HEADER } from "./fixture/click"
import { agentsStatus } from "../src/data/agents-status"
import {
  fakeTimers,
  tickerClock,
  understoryFixture,
  type UnderstorySpec,
} from "./fixture/understory"

const MIXED: readonly UnderstorySpec[] = [
  {
    id: "ses_c1",
    agent: "coder",
    title: "Rewrite the installer fallback",
    state: "running",
    tokens: 84_000,
    cost: 0.04,
    created: 1_100,
    tools: [
      { name: "read", args: "postinstall.mjs", status: "completed" },
      { name: "edit", args: "postinstall.mjs", status: "running" },
    ],
    output: ["the npm fallback still resolves the wrong tarball"],
  },
  {
    id: "ses_c2",
    agent: "coder",
    title: "Check registry metadata",
    state: "waiting",
    pending: 1,
    tokens: 61_000,
    cost: 0.02,
    created: 1_150,
    tools: [{ name: "bash", args: "npm pack --dry-run", status: "running" }],
  },
  {
    id: "ses_e1",
    agent: "explore",
    title: "Trace the binary resolver",
    state: "done",
    tokens: 42_000,
    created: 1_200,
    tools: [{ name: "code_find", args: "resolvePlatformPackage", status: "completed" }],
    summary: "two candidates share a package name",
  },
  {
    id: "ses_f1",
    agent: "general",
    title: "Try the alternate registry",
    state: "failed",
    tokens: 12_000,
    created: 1_300,
    tools: [{ name: "webfetch", args: "https://registry.example", status: "error" }],
    output: ["half done"],
  },
  {
    id: "ses_k1",
    agent: "scout",
    title: "Probe the Windows shim",
    state: "killed",
    killed: true,
    tokens: 4_000,
    created: 1_400,
  },
]

const FANOUT: readonly UnderstorySpec[] = Array.from({ length: 20 }, (_, index) => ({
  id: `ses_${index}`,
  agent: index % 2 === 0 ? "explore" : "coder",
  title: `branch task number ${index}`,
  state: index % 3 === 0 ? "running" : index % 7 === 0 ? "failed" : "done",
  tokens: 1_000 + index * 1_000,
  cost: index % 4 === 0 ? 0.01 : 0,
  created: 1_000 + index,
}))

interface RenderOptions {
  readonly width: number
  readonly height: number
  readonly clock?: ReturnType<typeof fakeTimers>
  readonly ticker?: ReturnType<typeof createTicker>
  /** Lens to click after mounting; the stream by default, `null` for Trace. */
  readonly lens?: "trace" | "roots" | "stream" | null
}

async function render(fixture: ReturnType<typeof understoryFixture>, options: RenderOptions) {
  const clock = options.clock ?? fakeTimers()
  const app = await mount(
    () => (
      <Understory
        context={fixture.context}
        sessionID="ses_root"
        mesh={fixture.mesh}
        ticker={options.ticker}
        timers={{ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }}
        now={clock.now}
      />
    ),
    { width: options.width, height: options.height },
  )
  await app.renderOnce()
  // Trace is the default lens; these tests cover the rest of the screen, so
  // they click the stream tab unless a caller keeps the default.
  if (options.lens !== null) clickRegion(app, LENS_TABS, `lens:${options.lens ?? "stream"}`)
  await app.renderOnce()
  await app.renderOnce()
  return { app, clock }
}

function frame(app: Awaited<ReturnType<typeof mount>>): string {
  return app.captureCharFrame()
}

/**
 * What the tab asks the host status row to say. The tab spends no row of its
 * own on it, so `say()` messages are read here rather than out of the frame.
 */
function statusText(): string | undefined {
  return agentsStatus()?.text
}

function expectFits(app: Awaited<ReturnType<typeof mount>>, width: number) {
  for (const line of frame(app).split("\n")) {
    expect(line.length).toBeLessThanOrEqual(width)
  }
}

function pressBind(fixture: ReturnType<typeof understoryFixture>, bind: string): boolean {
  const active = [...fixture.layers].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
  for (const layer of active) {
    if (layer.mode !== undefined && layer.mode !== "global" && layer.mode !== fixture.context.keymap.mode.current()) continue
    for (const command of layer.commands ?? []) {
      if (command.bind !== bind) continue
      if (command.enabled === false) continue
      if (typeof command.enabled === "function" && !command.enabled()) continue
      command.run()
      return true
    }
  }
  return false
}

test("the screen fits every reviewed size without wrapping", async () => {
  const sizes = [
    [200, 55],
    [168, 48],
    [120, 40],
    [100, 30],
    [80, 24],
  ] as const
  for (const [width, height] of sizes) {
    const fixture = understoryFixture({ specs: MIXED })
    const { app } = await render(fixture, { width, height })
    try {
      expectFits(app, width)
      const text = frame(app)
      // The mockup drops the RUN row below 28 terminal rows; everything else fits.
      if (height >= 28) expect(text).toContain("RUN")
      else expect(text).toContain("BRCH")
      expect(text).toContain("Trace")
    } finally {
      app.renderer.destroy()
    }
  }
  const fanout = await render(understoryFixture({ specs: FANOUT }), { width: 80, height: 24 })
  try {
    expectFits(fanout.app, 80)
  } finally {
    fanout.app.renderer.destroy()
  }
})

test("twenty agents fit, and the narrow roster says how many are below", async () => {
  const fixture = understoryFixture({ specs: FANOUT })
  const wide = await render(fixture, { width: 200, height: 55 })
  try {
    expect(frame(wide.app)).toContain("coder-10")
    expect(frame(wide.app)).not.toContain("more")
  } finally {
    wide.app.renderer.destroy()
  }

  const narrow = await render(understoryFixture({ specs: FANOUT }), { width: 80, height: 18 })
  try {
    expectFits(narrow.app, 80)
    // The panel spends no row on a hint line, so one more branch shows.
    expect(frame(narrow.app)).toContain("↓ 6 more")
  } finally {
    narrow.app.renderer.destroy()
  }
})

test("every roster size and both row modes keeps all twenty labels distinct", async () => {
  const specs: UnderstorySpec[] = Array.from({ length: 20 }, (_, index) => ({
    id: `ses_l${index}`,
    agent: index % 2 === 0 ? "explore" : "coder",
    title: `label task ${index}`,
    state: index % 3 === 0 ? "running" : "done",
    tokens: 1_000 + index,
    created: 1_000 + index,
  }))
  const groups = new Map<string, number>()
  const labels = specs.map((spec) => {
    const next = (groups.get(spec.agent!) ?? 0) + 1
    groups.set(spec.agent!, next)
    return `${spec.agent}-${next}`
  })

  for (const width of [200, 120, 100, 80]) {
    const roster = understoryColumns(width).roster
    for (const mode of [
      { height: 80, per: 3 },
      { height: 24, per: 1 },
    ] as const) {
      const fixture = understoryFixture({ specs })
      const { app } = await render(fixture, { width, height: mode.height })
      try {
        const rosterText = frame(app)
          .split("\n")
          .map((line) => line.slice(0, roster))
          .join("\n")
        const expected = labels.map((label) =>
          mode.per === 3
            ? shortLabel(label, roster - 5)
            : shortLabel(label, Math.min(roster - 5, 12)),
        )
        expect(new Set(expected).size).toBe(20)
        for (const label of expected) expect(rosterText).toContain(label)
      } finally {
        app.renderer.destroy()
      }
    }
  }
})

test("the roster header counts running, waiting, failed and done in that order, and merges killed into failed", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 120, height: 40 })
  try {
    const lines = frame(app).split("\n")
    const header = lines.slice(0, 4).map((line) => line.slice(0, understoryColumns(120).roster)).join("\n")
    expect(header).toContain("⣿1")
    expect(header).toContain("▲1")
    expect(header).toContain("✕2")
    expect(header).toContain("✓1")
    expect(header).not.toContain("⊘")
    expect(header).not.toContain("…")
    expect(header.indexOf("⣿1")).toBeLessThan(header.indexOf("▲1"))
    expect(header.indexOf("▲1")).toBeLessThan(header.indexOf("✕2"))
    expect(header.indexOf("✕2")).toBeLessThan(header.indexOf("✓1"))
  } finally {
    app.renderer.destroy()
  }
})

test("below 28 rows the roster header keeps only the branch count", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 80, height: 24 })
  try {
    const lines = frame(app).split("\n")
    const header = lines.slice(0, 2).map((line) => line.slice(0, understoryColumns(80).roster)).join("\n")
    expect(header).toContain("BRCH")
    expect(header).not.toContain("RUN")
    expect(header).not.toContain("⣿")
    expect(header).not.toContain("tok")
  } finally {
    app.renderer.destroy()
  }
})

test("a zero token total is hidden on the roster", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 200, height: 45 })
  try {
    const rosterText = frame(app)
      .split("\n")
      .map((line) => line.slice(0, understoryColumns(200).roster))
      .join("\n")
    expect(rosterText).not.toMatch(/^[\s▌]*0[\s]*$/m)
    expect(rosterText).toContain("84.0k")
  } finally {
    app.renderer.destroy()
  }
})

test("RETURNED only lists finished branches, not running or failed ones", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 200, height: 45 })
  try {
    const lines = frame(app)
      .split("\n")
      .map((line) => line.slice(200 - 44))
    const start = lines.findIndex((line) => line.includes("RETURNED"))
    expect(start).toBeGreaterThan(-1)
    const returned = lines.slice(start).join("\n")
    expect(returned).toContain("explore")
    expect(returned).toContain("two candidates share a package name")
    expect(returned).not.toContain("coder-1")
    expect(returned).not.toContain("half done")
  } finally {
    app.renderer.destroy()
  }
})

test("RUN uses the stream's newest event and keeps an ended run's final duration", async () => {
  const late = () =>
    understoryFixture({
      root: { state: "idle", idle: 2_000 },
      specs: [{ id: "ses_late", agent: "coder", title: "late event", state: "done", created: 4_990 }],
    })
  const liveRun = await render(late(), { width: 120, height: 40, clock: fakeTimers(6_000) })
  try {
    const text = frame(liveRun.app)
    // Root started at 900. The newest stream entry is at 5000, so the run is 4s,
    // not 5s (now) and not 1s (the root's own idle mark).
    expect(text).toContain("RUN 0:04")
    expect(text).toContain("0:04")
  } finally {
    liveRun.app.renderer.destroy()
  }

  const ended = await render(late(), { width: 120, height: 40, clock: fakeTimers(60_000) })
  try {
    // The run ended, so a later wall clock must not inflate RUN.
    expect(frame(ended.app)).toContain("RUN 0:04")
  } finally {
    ended.app.renderer.destroy()
  }
})

test("every state has a distinct glyph, and failed or killed never reads finished", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 200, height: 45 })
  try {
    const text = frame(app)
    expect(text).toContain("▲")
    expect(text).toContain("✓")
    expect(text).toContain("✕")
    expect(text).toContain("⊘")
    expect(text).toContain("RUN")
    expect(text).toContain("failed !")

    for (let step = 0; step < 4; step += 1) expect(fixture.press("Next row")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("FAILED")
    expect(frame(app)).not.toContain("FINISHED")

    expect(fixture.press("Next row")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("KILLED")
    expect(frame(app)).not.toContain("FINISHED")
  } finally {
    app.renderer.destroy()
  }
})

test("a waiting agent shows on the row and inspector, and clears when the reply lands", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 200, height: 45 })
  try {
    expect(await clickRegion(app, ROSTER, "row:ses_c2")).toBe(true)
    await app.renderOnce()
    const waiting = frame(app)
    expect(waiting).toContain("▲")
    expect(waiting).toContain("NEEDS YOU")
    expect(waiting).toContain("allow once")
    expect(waiting).toContain("bash")
    expect(waiting).toContain("npm pack --dry-run")

    expect(await clickRegion(app, INSPECTOR_ASK, "once")).toBe(true)
    await app.renderOnce()
    expect(fixture.replies).toHaveLength(1)
    expect(fixture.replies[0]).toEqual({
      sessionID: "ses_c2",
      requestID: "perm_ses_c2_0",
      decision: "once",
    })
    const cleared = frame(app)
    expect(cleared).not.toContain("NEEDS YOU")
    expect(cleared).not.toContain("▲")
  } finally {
    app.renderer.destroy()
  }
})

test("the allow keys never pick another agent, and several requests answer the oldest", async () => {
  const fixture = understoryFixture({
    specs: [
      { ...MIXED[0]!, pending: 0 },
      { ...MIXED[1]!, id: "ses_c2", agent: "coder", title: "second", pending: 2 },
    ],
  })
  const { app } = await render(fixture, { width: 200, height: 40 })
  try {
    // Selecting a running branch shows no ask, so there is nothing to answer.
    expect(fixture.press("Next row")).toBe(true)
    await app.renderOnce()
    expect(await clickRegion(app, INSPECTOR_ASK, "once")).toBe(false)

    // The waiting branch's ask answers its oldest request.
    expect(await clickRegion(app, ROSTER, "row:ses_c2")).toBe(true)
    await app.renderOnce()
    expect(await clickRegion(app, INSPECTOR_ASK, "always")).toBe(true)
    await app.renderOnce()
    expect(fixture.replies).toHaveLength(1)
    expect(fixture.replies[0]?.requestID).toBe("perm_ses_c2_0")
    expect(fixture.replies[0]?.decision).toBe("always")
  } finally {
    app.renderer.destroy()
  }
})

test("a question offers only open session, never an allow or deny", async () => {
  const fixture = understoryFixture({
    specs: [{ id: "ses_question", agent: "coder", title: "pick a registry", state: "waiting", question: true }],
  })
  const { app } = await render(fixture, { width: 200, height: 40 })
  try {
    expect(await clickRegion(app, ROSTER, "row:ses_question")).toBe(true)
    await app.renderOnce()
    const asking = frame(app)
    expect(asking).toContain("QUESTION")
    expect(asking).toContain("Which registry?")
    expect(asking).toContain("open session")
    expect(await clickRegion(app, INSPECTOR_ASK, "once")).toBe(false)
    expect(await clickRegion(app, INSPECTOR_ASK, "open")).toBe(true)
    await app.renderOnce()
    expect(fixture.replies).toHaveLength(0)
    expect(fixture.navigated).toEqual([{ type: "session", sessionID: "ses_question" }])
  } finally {
    app.renderer.destroy()
  }
})

test("x kills only on a second press within three seconds, and selection or the timer disarms it", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const clock = fakeTimers()
  const { app } = await render(fixture, { width: 200, height: 45, clock })
  try {
    expect(fixture.press("Next row")).toBe(true)
    expect(await clickRegion(app, INSPECTOR_ACTIONS, "kill")).toBe(true)
    await app.renderOnce()
    expect(statusText()).toBe("kill coder-1? use kill again to confirm")
    expect(fixture.kills).toHaveLength(0)

    expect(await clickRegion(app, INSPECTOR_ACTIONS, "kill")).toBe(true)
    await app.renderOnce()
    expect(fixture.kills).toHaveLength(1)
    expect(fixture.kills[0]).toMatchObject({ parentSessionID: "ses_root", targetSessionID: "ses_c1" })
  } finally {
    app.renderer.destroy()
  }

  const timed = understoryFixture({ specs: MIXED })
  const secondClock = fakeTimers()
  const timedApp = await render(timed, { width: 200, height: 45, clock: secondClock })
  try {
    expect(timed.press("Next row")).toBe(true)
    expect(await clickRegion(timedApp.app, INSPECTOR_ACTIONS, "kill")).toBe(true)
    secondClock.advance(3_000)
    expect(await clickRegion(timedApp.app, INSPECTOR_ACTIONS, "kill")).toBe(true)
    await timedApp.app.renderOnce()
    expect(timed.kills).toHaveLength(0)
    expect(statusText()).toBe("kill coder-1? use kill again to confirm")
  } finally {
    timedApp.app.renderer.destroy()
  }

  const moved = understoryFixture({ specs: MIXED })
  const movedApp = await render(moved, { width: 200, height: 45 })
  try {
    expect(moved.press("Next row")).toBe(true)
    expect(await clickRegion(movedApp.app, INSPECTOR_ACTIONS, "kill")).toBe(true)
    expect(moved.press("Next row")).toBe(true)
    expect(await clickRegion(movedApp.app, INSPECTOR_ACTIONS, "kill")).toBe(true)
    await movedApp.app.renderOnce()
    expect(moved.kills).toHaveLength(0)
    expect(statusText()).toBe("kill coder-2? use kill again to confirm")
  } finally {
    movedApp.app.renderer.destroy()
  }
})

test("the kill timer is cleared when the screen goes away", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const clock = fakeTimers()
  const { app } = await render(fixture, { width: 200, height: 45, clock })
  expect(fixture.press("Next row")).toBe(true)
  expect(await clickRegion(app, INSPECTOR_ACTIONS, "kill")).toBe(true)
  expect(clock.count()).toBeGreaterThan(0)
  app.renderer.destroy()
  expect(clock.count()).toBe(0)
})

test("composer focus keeps every panel key in the composer", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 200, height: 45 })
  try {
    expect(await clickRegion(app, ROSTER, "row:ses_c2")).toBe(true)
    fixture.setMode("base")
    // While the composer owns the keyboard no panel command is reachable.
    expect(fixture.press("Next row")).toBe(false)
    expect(fixture.press("Open agent session")).toBe(false)
    await app.renderOnce()
    expect(fixture.replies).toHaveLength(0)
    expect(fixture.kills).toHaveLength(0)
  } finally {
    app.renderer.destroy()
  }
})

test("escape backs out one level and only then reaches the panel close", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  let closed = 0
  fixture.layers.push({
    mode: "global",
    priority: 0,
    commands: [
      {
        bind: "escape",
        title: "Close BanyanCode panel",
        run: () => {
          closed += 1
        },
      },
    ],
  })
  // Wide enough for the docked inspector, so the action row is on screen; the
  // overlay's own Esc level is covered by the overlay test.
  const { app } = await render(fixture, { width: 168, height: 40 })
  try {
    expect(pressBind(fixture, "escape")).toBe(true)
    expect(closed).toBe(1)

    expect(await clickRegion(app, STREAM_HEADER, "stream:filter")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("build only")
    expect(pressBind(fixture, "escape")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("All branches")
    expect(closed).toBe(1)

    expect(fixture.press("Next row")).toBe(true)
    expect(await clickRegion(app, INSPECTOR_ACTIONS, "kill")).toBe(true)
    await app.renderOnce()
    expect(statusText() ?? "").toContain("confirm")
    expect(pressBind(fixture, "escape")).toBe(true)
    await app.renderOnce()
    expect(statusText() ?? "").not.toContain("confirm")
    expect(closed).toBe(1)

    expect(pressBind(fixture, "escape")).toBe(true)
    expect(closed).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("filter, fold, Tab and Enter all move the screen", async () => {
  const fixture = understoryFixture({
    specs: [
      { ...MIXED[0]!, state: "done", pending: 0 },
      { ...MIXED[2]!, id: "ses_done2", state: "done" },
      { ...MIXED[1]!, id: "ses_run", agent: "coder", state: "running", pending: 0 },
    ],
  })
  // Wide enough for the docked inspector, so the action row is on screen.
  const { app } = await render(fixture, { width: 168, height: 40 })
  try {
    expect(await clickRegion(app, ROSTER, "fold")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("2 done")
    expect(frame(app)).not.toContain("show done")

    expect(fixture.press("Next row")).toBe(true)
    expect(await clickRegion(app, ROSTER, "fold")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("show done")

    expect(await clickRegion(app, STREAM_HEADER, "stream:filter")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("coder-2 only")

    expect(fixture.press("Focus composer")).toBe(true)
    expect(fixture.dispatched).toContain("pane.focus.left")

    expect(await clickRegion(app, INSPECTOR_ACTIONS, "open")).toBe(true)
    expect(fixture.navigated).toEqual([{ type: "session", sessionID: "ses_run" }])
  } finally {
    app.renderer.destroy()
  }
})

/**
 * The panel at the mockup's 168x48 terminal: 39 rows under the chrome, which
 * is the composer's five rows and the status row. Nine branches at three rows
 * each, and one row at the bottom shared by the lens legend, the roster's fold
 * hint and the inspector's actions.
 */
const NINE: readonly UnderstorySpec[] = [
  ...MIXED.slice(0, 4),
  { id: "ses_c3", agent: "coder", title: "fourth branch", state: "running", tokens: 9_000, created: 1_350 },
  { id: "ses_e2", agent: "explore", title: "fifth branch", state: "done", tokens: 7_000, created: 1_375 },
  { id: "ses_s1", agent: "scout", title: "sixth branch", state: "done", tokens: 5_000, created: 1_400 },
  { id: "ses_g2", agent: "general", title: "seventh branch", state: "running", tokens: 3_000, created: 1_425 },
]

test("at 168x48 the panel spends no row on hints: nine branches take three rows, and the last row is shared", async () => {
  const fixture = understoryFixture({ specs: NINE })
  const { app } = await render(fixture, { width: 168, height: 39, lens: null })
  try {
    // A live subagent is selected, so the inspector offers all three actions.
    expect(fixture.press("Next row")).toBe(true)
    await app.renderOnce()
    const lines = frame(app).split("\n")
    const cols = understoryColumns(168)
    const roster = (y: number) => lines[y]!.slice(0, cols.roster)
    const inspector = (y: number) => lines[y]!.slice(cols.roster + cols.stream)
    // Tabs, then three overview rows, then the ruler: the first lane row is 5.
    const top = rowGeometry(39, 9).header
    expect(top).toBe(5)
    expect(rowGeometry(39, 9).laneHeight).toBe(3)
    expect(roster(top)).toContain("build")
    expect(roster(top + 3)).toContain("coder-1")
    expect(roster(top + 6)).toContain("coder-2")

    // The legend, the fold hint and the action row all land on the last row.
    const last = lines[38]!
    expect(last).toContain("R read  S search  E edit  $ shell  V verify  W web")
    expect(last).not.toContain("drag overview to zoom")
    expect(roster(38)).toContain("done")
    expect(inspector(38)).toContain("steer")
    expect(inspector(38)).toContain("kill")
    expect(inspector(38)).toContain("open session")
    // The rule above the actions sits on the row before it.
    expect(inspector(37)).toContain("────")
  } finally {
    app.renderer.destroy()
  }
})

test("the noise-free status row is published for the host footer instead of drawn", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 168, height: 39, lens: null })
  try {
    // coder-2 is waiting, so the row leads with the ask and ends with the keys.
    expect(agentsStatus()?.text).toBe("▲ coder-2 needs you: npm pack --dry-run")
    expect(agentsStatus()?.tone).toBe("warning")
    expect(agentsStatus()?.hints).toEqual([])
    // Nothing of it is spent on a panel row, and the message is a target that
    // selects the agent it names.
    const text = frame(app)
    expect(text).not.toContain("1-3 lens")
    expect(typeof agentsStatus()?.onAttention).toBe("function")
    await app.renderOnce()
    expect(agentsStatus()?.text).toBe("▲ coder-2 needs you: npm pack --dry-run")
  } finally {
    app.renderer.destroy()
  }
  // Leaving the tab clears it, so chat keeps its own status row.
  expect(agentsStatus()).toBeUndefined()
})

test("the inspector overlay is toggled from the lens tabs and does not resize the columns", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 120, height: 40 })
  try {
    const before = frame(app)
    expect(before).not.toContain("TOKENS BY BRANCH")
    expect(await clickRegion(app, LENS_TABS, "lens:details")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("TOKENS BY BRANCH")
    expectFits(app, 120)
    // The roster columns never move: the overlay floats above them.
    const roster = understoryColumns(120).roster
    expect(frame(app).split("\n")[0]!.slice(0, roster)).toBe(before.split("\n")[0]!.slice(0, roster))
    // The overlay carries its own close control, and Esc backs out too.
    expect(frame(app)).toContain("close ×")
    expect(await clickRegion(app, "banyancode.understory.overlay.chrome", "overlay:close")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).not.toContain("TOKENS BY BRANCH")
  } finally {
    app.renderer.destroy()
  }
})

test("the stream follows, pauses on scroll, anchors the oldest visible entry and returns with End", async () => {
  const tools = Array.from({ length: 80 }, (_, index) => ({
    name: "read",
    args: `file-${String(index).padStart(2, "0")}.ts`,
    status: "completed" as const,
  }))
  const fixture = understoryFixture({
    specs: [{ id: "ses_stream", agent: "explore", title: "many calls", state: "done", tools }],
  })
  const { app } = await render(fixture, { width: 120, height: 30 })
  try {
    expect(frame(app)).toContain("file-79.ts")
    expect(frame(app)).not.toContain("file-00.ts")

    const scroll = app.renderer.root.findDescendantById("banyancode.understory.stream") as unknown as ScrollBoxRenderable
    expect(scroll).toBeDefined()
    expect(scroll.content.getChildrenCount()).toBeLessThanOrEqual(28)

    expect(pressBind(fixture, "home")).toBe(true)
    await app.renderOnce()
    const paused = frame(app)
    expect(paused).toContain("↓ latest")
    expect(paused).toContain("file-00.ts")

    fixture.append("ses_stream", {
      id: "ses_stream_new",
      type: "user",
      time: { created: 20_000 },
      text: "brand new event",
    } as unknown as SessionMessageInfo)
    await app.renderOnce()
    const anchored = frame(app)
    expect(anchored).toContain("file-00.ts")
    expect(anchored).not.toContain("brand new event")
    expect(anchored).toContain("↓ latest")

    expect(pressBind(fixture, "end")).toBe(true)
    await app.renderOnce()
    const followed = frame(app)
    expect(followed).toContain("brand new event")
    expect(followed).not.toContain("↓ latest")
  } finally {
    app.renderer.destroy()
  }
})

test("stream rows carry real event glyphs and a finished call's timing, never a replacement character", async () => {
  const fixture = understoryFixture({
    specs: [
      {
        id: "ses_row",
        agent: "explore",
        title: "reads the file",
        state: "done",
        tools: [{ name: "read", args: "math.ts", status: "completed" }],
        summary: "three exports",
      },
    ],
  })
  const { app } = await render(fixture, { width: 200, height: 40 })
  try {
    const text = frame(app)
    expect(text).toContain("✓ read")
    expect(text).toContain("0.0s")
    expect(text).toContain("│ three exports")
    expect(text).not.toContain("\uFFFD")
  } finally {
    app.renderer.destroy()
  }
})

test("selection stays visible in a scrolling roster", async () => {
  const fixture = understoryFixture({ specs: FANOUT })
  const { app } = await render(fixture, { width: 80, height: 18 })
  try {
    for (let step = 0; step < 15; step += 1) expect(fixture.press("Next row")).toBe(true)
    await app.renderOnce()
    const text = frame(app)
    expect(text).toContain("▌")
    expect(text).toContain("expl…-8")
    expect(text).toContain("↓ 5 more")
  } finally {
    app.renderer.destroy()
  }
})

test("a truncated history says earlier activity is not loaded", async () => {
  const fixture = understoryFixture({
    specs: [{ id: "ses_cut", agent: "explore", title: "long branch", state: "done", truncated: true }],
  })
  const { app } = await render(fixture, { width: 200, height: 40 })
  try {
    expect(frame(app)).toContain("earlier activity not loaded")
    expect(fixture.press("Next row")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("earlier activity not loaded")
  } finally {
    app.renderer.destroy()
  }
})

test("an empty run says no branches and where they will appear", async () => {
  const fixture = understoryFixture({ root: { state: "idle" }, rootMessages: false })
  const { app } = await render(fixture, { width: 120, height: 30 })
  try {
    const text = frame(app)
    expect(text).toContain("No branches yet")
    expect(text).toContain("Agents appear here when the agent fans out.")
  } finally {
    app.renderer.destroy()
  }
})

test("the root inspector is the run sheet, with per-branch tokens and returns", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 200, height: 45 })
  try {
    const text = frame(app)
    expect(text).toContain("TOKENS BY BRANCH")
    expect(text).toContain("RETURNED")
    expect(text).toContain("two candidates share a package name")
    expect(text).toContain("coder-1")
  } finally {
    app.renderer.destroy()
  }
})

test("cost is hidden at zero and shown when it is real", async () => {
  const fixture = understoryFixture({
    specs: [
      { id: "ses_free", agent: "explore", title: "free", state: "done", cost: 0 },
      { id: "ses_paid", agent: "coder", title: "paid", state: "done", cost: 0.04 },
    ],
  })
  const { app } = await render(fixture, { width: 200, height: 40 })
  try {
    const text = frame(app)
    expect(text).not.toContain("$0.00")
    expect(text).toContain("$0.04")
  } finally {
    app.renderer.destroy()
  }
})

test("the ticker is idle with nothing running, runs while an agent runs, and stops on dispose", async () => {
  const clock = tickerClock()
  const idleTicker = createTicker({
    animations: () => true,
    now: clock.now,
    setInterval: clock.options.setInterval,
    clearInterval: clock.options.clearInterval,
  })
  const idle = understoryFixture({
    root: { state: "idle" },
    specs: [{ id: "ses_done", agent: "explore", state: "done" }],
  })
  const idleApp = await render(idle, { width: 120, height: 30, ticker: idleTicker })
  try {
    expect(idleTicker.subscribers()).toBe(0)
    expect(idleTicker.running()).toBe(false)
  } finally {
    idleApp.app.renderer.destroy()
  }

  const runningTicker = createTicker({
    animations: () => true,
    now: clock.now,
    setInterval: clock.options.setInterval,
    clearInterval: clock.options.clearInterval,
  })
  const running = understoryFixture({
    animations: true,
    specs: [{ id: "ses_run", agent: "explore", state: "running" }],
  })
  const runningApp = await render(running, { width: 120, height: 30, ticker: runningTicker })
  try {
    expect(runningTicker.subscribers()).toBe(1)
    expect(runningTicker.running()).toBe(true)
    expect(clock.live()).toBe(1)
    const before = frame(runningApp.app)
    clock.tick(100)
    await runningApp.app.renderOnce()
    expect(runningTicker.frame()).toBe(1)
    expect(frame(runningApp.app)).not.toBe(before)
  } finally {
    runningApp.app.renderer.destroy()
    expect(runningTicker.subscribers()).toBe(0)
    expect(clock.live()).toBe(0)
  }
})

test("animations off draws final states and starts no timer", async () => {
  const clock = tickerClock()
  const ticker = createTicker({
    animations: () => false,
    now: clock.now,
    setInterval: clock.options.setInterval,
    clearInterval: clock.options.clearInterval,
  })
  const fixture = understoryFixture({
    specs: [
      { ...MIXED[0]!, state: "waiting", pending: 1 },
      { id: "ses_spin", agent: "explore", title: "still working", state: "running", created: 1_250 },
    ],
    animations: false,
  })
  const { app } = await render(fixture, { width: 120, height: 30, ticker })
  try {
    expect(ticker.running()).toBe(false)
    expect(clock.live()).toBe(0)
    expect(frame(app)).toContain("▲")
    expect(frame(app)).toContain("⋯")
  } finally {
    app.renderer.destroy()
  }
})

test("1 2 3 switch the lens, and the tab strip carries the live clock", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const { app } = await render(fixture, { width: 168, height: 48, clock: fakeTimers(12_000) })
  try {
    const stream = frame(app)
    expect(stream).toContain("Trace")
    expect(stream).toContain("Roots")
    expect(stream).toContain("Stream")
    expect(stream).toContain("LIVE")
    expect(stream).toContain("All branches")

    expect(await clickRegion(app, LENS_TABS, "lens:trace")).toBe(true)
    await app.renderOnce()
    const trace = frame(app)
    expect(trace).toContain("R read")
    expect(trace).toContain("NOW")
    expect(trace).not.toContain("Trace is not built yet.")
    expect(trace).not.toContain("All branches")

    expect(await clickRegion(app, LENS_TABS, "lens:roots")).toBe(true)
    await app.renderOnce()
    // Without a code graph the lens is the gap-(d) fallback: a flat map of the
    // touched files (none here) and the build hint.
    expect(frame(app)).toContain("/codegraph-build")
    expect(frame(app)).toContain("stale edit")

    expect(await clickRegion(app, LENS_TABS, "lens:stream")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("All branches")
    expectFits(app, 168)
  } finally {
    app.renderer.destroy()
  }
})

test("left and right scroll the Trace time axis, and the latest control resumes", async () => {
  const fixture = understoryFixture({
    specs: [
      {
        id: "ses_late",
        agent: "coder",
        title: "late work",
        state: "running",
        created: 60_000,
        tools: [{ name: "read", args: "late.ts", status: "completed" }],
      },
    ],
  })
  const { app } = await render(fixture, { width: 120, height: 40, clock: fakeTimers(90_000), lens: null })
  try {
    expect(frame(app)).not.toContain("→ latest")
    expect(fixture.press("Scroll time back")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).toContain("→ latest")

    expect(fixture.press("Scroll time forward")).toBe(true)
    expect(fixture.press("Scroll time forward")).toBe(true)
    await app.renderOnce()
    expect(frame(app)).not.toContain("→ latest")
  } finally {
    app.renderer.destroy()
  }
})

test("the lens survives leaving the tab and coming back", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const first = await render(fixture, { width: 168, height: 48, lens: null })
  try {
    expect(await clickRegion(first.app, LENS_TABS, "lens:roots")).toBe(true)
    await first.app.renderOnce()
    expect(frame(first.app)).toContain("/codegraph-build")
  } finally {
    first.app.renderer.destroy()
  }
  // ctrl+] unmounts the panel; coming back must not silently reset to Trace.
  const second = await render(fixture, { width: 168, height: 48, lens: null })
  try {
    expect(frame(second.app)).toContain("/codegraph-build")
  } finally {
    second.app.renderer.destroy()
  }
})

test("mounted through the panel at both widths", async () => {
  const fixture = understoryFixture({ specs: MIXED })
  const panel = await mount(
    () => (
      <InspectorPanel
        context={fixture.context}
        live={live({ mesh: fixture.mesh })}
        panel={{
          name: PANEL.agents,
          sessionID: "ses_root",
          width: 200,
          presentation: "main",
          focused: true,
          focus: () => {},
          close: () => {},
          toggleFullscreen: () => {},
        }}
      />
    ),
    { width: 200, height: 45 },
  )
  try {
    await panel.renderOnce()
    expect(panel.captureCharFrame()).toContain("RUN")
    expect(panel.captureCharFrame()).toContain("TOKENS BY BRANCH")
  } finally {
    panel.renderer.destroy()
  }

  const narrowFixture = understoryFixture({ specs: MIXED })
  const narrow = await mount(
    () => (
      <InspectorPanel
        context={narrowFixture.context}
        live={live({ mesh: narrowFixture.mesh })}
        panel={{
          name: PANEL.agents,
          sessionID: "ses_root",
          width: 120,
          presentation: "main",
          focused: true,
          focus: () => {},
          close: () => {},
          toggleFullscreen: () => {},
        }}
      />
    ),
    { width: 120, height: 40 },
  )
  try {
    await narrow.renderOnce()
    expect(narrow.captureCharFrame()).not.toContain("TOKENS BY BRANCH")
    expect(await clickRegion(narrow, LENS_TABS, "lens:details")).toBe(true)
    await narrow.renderOnce()
    expect(narrow.captureCharFrame()).toContain("TOKENS BY BRANCH")
  } finally {
    narrow.renderer.destroy()
  }
})
