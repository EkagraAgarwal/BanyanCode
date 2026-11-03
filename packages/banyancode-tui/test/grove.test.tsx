/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { Grove } from "../src/components/grove"
import { InspectorPanel } from "../src/components/panels/inspector"
import { PANEL } from "../src/constants"
import { createTicker } from "../src/motion"
import { live, mount } from "./harness"
import { groveFixture, type GroveSpec } from "./fixture/grove"

function fixtureContext(input: {
  readonly base: Context
  readonly prompts?: readonly string[]
  readonly confirms?: readonly boolean[]
}) {
  const layers: Array<{ readonly commands?: readonly KeymapCommand[] }> = []
  const navigated: unknown[] = []
  const prompts = [...(input.prompts ?? [])]
  const confirms = [...(input.confirms ?? [])]
  const value = {
    ...input.base,
    keymap: {
      ...input.base.keymap,
      layer: (factory: () => { readonly commands?: readonly KeymapCommand[] }) => {
        layers.push(factory())
      },
    },
    ui: {
      ...input.base.ui,
      router: {
        ...input.base.ui.router,
        navigate: (destination: unknown) => navigated.push(destination),
      },
      dialog: {
        ...input.base.ui.dialog,
        prompt: async () => prompts.shift(),
        confirm: async () => confirms.shift(),
      },
    },
  } as unknown as Context
  const press = async (title: string) => {
    for (const layer of [...layers].reverse()) {
      const command = layer.commands?.find((item) => item.title === title)
      if (!command) continue
      const enabled = command.enabled
      if (enabled === false) continue
      if (typeof enabled === "function" && !enabled()) continue
      await command.run()
      return true
    }
    return false
  }
  return { context: value, press, navigated, layers }
}

function fakeClock() {
  const timers = new Map<number, () => void>()
  let next = 1
  let scheduled = 0
  let clock = 0
  return {
    options: {
      now: () => clock,
      setInterval: ((fn: () => void) => {
        const id = next++
        timers.set(id, fn)
        scheduled++
        return id as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: ((id: unknown) => {
        timers.delete(id as number)
      }) as unknown as typeof clearInterval,
    },
    tick(ms: number) {
      clock += ms
      for (const fn of [...timers.values()]) fn()
    },
    scheduled: () => scheduled,
    live: () => timers.size,
  }
}

const STATES: readonly GroveSpec[] = [
  {
    id: "ses_explore",
    agent: "explore",
    title: "Trace how the installer resolves binaries",
    state: "running",
    tokens: 81_000,
    cost: 0.02,
    created: 1_100,
    tools: [
      { name: "code_find", args: "resolvePlatformPackage", status: "completed" },
      { name: "read", args: "postinstall.mjs", status: "completed" },
      { name: "grep", args: "optionalDependencies", status: "running" },
    ],
    output: ["tracing callers through the installer", "two candidates share a package name"],
  },
  {
    id: "ses_scout",
    agent: "scout",
    title: "Check the npm fallback on Windows",
    state: "waiting",
    tokens: 61_000,
    cost: 0.01,
    created: 1_200,
    tools: [{ name: "read", args: "postinstall.mjs", status: "completed" }],
  },
  {
    id: "ses_done",
    agent: "coder",
    title: "Add version check and working fallback",
    state: "done",
    tokens: 96_000,
    cost: 0.04,
    created: 1_300,
    tools: [
      { name: "edit", args: "postinstall.mjs", status: "completed" },
      { name: "verify", args: "typecheck", status: "completed" },
    ],
    summary: "patched, 214 tests pass",
  },
  {
    id: "ses_failed",
    agent: "general",
    title: "Try the alternate registry",
    state: "failed",
    tokens: 12_000,
    cost: 0.01,
    created: 1_400,
    tools: [{ name: "bash", args: "npm view", status: "error" }],
  },
]

async function render(
  fixture: ReturnType<typeof groveFixture>,
  options: { readonly width: number; readonly height: number; readonly ticker?: ReturnType<typeof createTicker>; readonly context?: Context },
) {
  const app = await mount(
    () => (
      <Grove
        context={options.context ?? fixture.context}
        sessionID="ses_root"
        mesh={fixture.mesh}
        ticker={options.ticker}
      />
    ),
    { width: options.width, height: options.height },
  )
  // The panel measures itself; one more pass paints the first measured frame.
  await app.renderOnce()
  return app
}

test("the grove header names the root agent, its state and the branch row", async () => {
  const fixture = groveFixture({ specs: STATES, pending: () => new Set(["ses_scout"]) })
  const app = await render(fixture, { width: 200, height: 32 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("build")
    expect(frame).toContain("1 branch growing")
    expect(frame).toContain("1 waiting on you")
    expect(frame).toContain("╭")
    expect(frame).toContain("╮")
    expect(frame).toContain("┴")
  } finally {
    app.renderer.destroy()
  }
})

test("every pane state has its own label and the failed states never read DONE", async () => {
  const fixture = groveFixture({
    specs: [...STATES, { ...STATES[2]!, id: "ses_killed", created: 1_500 }],
    pending: () => new Set(["ses_scout"]),
    killed: ["ses_killed"],
  })
  const app = await render(fixture, { width: 200, height: 40 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("ACTIVE")
    expect(frame).toContain("WAITING")
    expect(frame).toContain("DONE")
    expect(frame).toContain("FAILED")
    expect(frame).toContain("KILLED")
    expect(frame.split("\n").filter((line) => line.includes("FAILED")).every((line) => !line.includes("DONE"))).toBe(true)
    expect(frame.split("\n").filter((line) => line.includes("KILLED")).every((line) => !line.includes("DONE"))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("a pending permission sets WAITING and answering clears it", async () => {
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set(["ses_scout"]))
  const fixture = groveFixture({ specs: [STATES[0]!, STATES[1]!], pending: () => pending() })
  const app = await render(fixture, { width: 120, height: 30 })
  try {
    expect(app.captureCharFrame()).toContain("WAITING")
    setPending(new Set<string>())
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("WAITING")
    // The mesh still reports the child as running; only the blocked state cleared.
    expect(frame).toContain("ACTIVE")
  } finally {
    app.renderer.destroy()
  }
})

test("a pane with no assistant text shows no placeholder narration", async () => {
  const fixture = groveFixture({
    specs: [{ id: "ses_quiet", agent: "scout", title: "Check the npm fallback", state: "done", tokens: 1_000 }],
  })
  const app = await render(fixture, { width: 100, height: 30 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("scout")
    expect(frame).toContain("DONE")
    expect(frame).not.toContain("RETURNED")
    expect(frame).not.toContain("no output")
    expect(frame).not.toContain("waiting for")
  } finally {
    app.renderer.destroy()
  }
})

test("a done pane shows RETURNED and the child's own summary", async () => {
  const fixture = groveFixture({ specs: [STATES[2]!] })
  const app = await render(fixture, { width: 100, height: 30 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("RETURNED")
    expect(frame).toContain("patched, 214 tests pass")
  } finally {
    app.renderer.destroy()
  }
})

test("nested subagents are indented inside their parent's pane", async () => {
  const fixture = groveFixture({
    specs: [
      STATES[0]!,
      { id: "ses_child", agent: "scout", title: "read the manifest", state: "running", parentID: "ses_explore", tokens: 4_000 },
    ],
  })
  const app = await render(fixture, { width: 100, height: 30 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("explore")
    expect(frame).toContain("↳")
    expect(frame).toContain("scout")
    expect(frame).toContain("running")
  } finally {
    app.renderer.destroy()
  }
})

test("twenty agents keep the frame intact and put the overflow in a scrollbox", async () => {
  const specs = Array.from({ length: 20 }, (_, index): GroveSpec => ({
    id: `ses_${index}`,
    agent: index % 2 === 0 ? "explore" : "coder",
    title: `branch ${index}`,
    state: "running",
    tokens: 1_000 + index,
    created: 1_000 + index,
    tools: [{ name: "read", args: `file-${index}`, status: "completed" }],
  }))
  const fixture = groveFixture({ specs, animations: false })
  const app = await render(fixture, { width: 168, height: 48 })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(168)
    const overflow = app.renderer.root.findDescendantById("banyancode.grove.overflow")
    expect(overflow).toBeDefined()
    expect(frame).toContain("20 branches growing")
    expect(frame).toContain("read file-0")
  } finally {
    app.renderer.destroy()
  }
})

test("repeated agents collapse into one group entry in the overflow row", async () => {
  const specs = Array.from({ length: 8 }, (_, index): GroveSpec => ({
    id: `ses_${index}`,
    agent: "explore",
    title: `branch ${index}`,
    state: "running",
    tokens: 1_000 + index,
    created: 1_000 + index,
  }))
  const fixture = groveFixture({ specs })
  const app = await render(fixture, { width: 100, height: 40 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("explore ×6")
    expect(frame).toContain("collapsed")
  } finally {
    app.renderer.destroy()
  }
})

test("the narrow layout shows one pane plus a selectable list", async () => {
  const fixture = groveFixture({ specs: STATES })
  const app = await render(fixture, { width: 83, height: 34 })
  try {
    const frame = app.captureCharFrame()
    expect(app.renderer.root.findDescendantById("banyancode.grove.list")).toBeDefined()
    expect(frame).toContain("explore")
    expect(frame).toContain("scout")
    expect(frame).toContain("coder")
    expect(frame).toContain("general")
    // One pane body, not four: the other agents are list rows.
    expect(frame.split("\n").filter((line) => line.includes("ACTIVE")).length).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("the frame is clean at every supported size", async () => {
  const fixture = groveFixture({ specs: STATES, pending: () => new Set(["ses_scout"]), animations: false })
  for (const [width, height] of [
    [200, 55],
    [168, 48],
    [120, 40],
    [100, 30],
  ] as const) {
    const app = await render(fixture, { width, height })
    try {
      const frame = app.captureCharFrame()
      for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(width)
      expect(frame).toContain("explore")
      expect(frame).toContain("WAITING")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("keyboard selects a pane and enter opens its session", async () => {
  const fixture = groveFixture({ specs: STATES })
  const recorded = fixtureContext({ base: fixture.context })
  const app = await render(fixture, { width: 120, height: 30, context: recorded.context })
  try {
    expect(await recorded.press("Next row")).toBe(true)
    await app.renderOnce()
    expect(await recorded.press("Run action")).toBe(true)
    expect(recorded.navigated[0]).toEqual({ type: "session", sessionID: "ses_scout" })
  } finally {
    app.renderer.destroy()
  }
})

test("steer and kill act on the selected agent's own session", async () => {
  const fixture = groveFixture({ specs: STATES })
  const recorded = fixtureContext({ base: fixture.context, prompts: ["go faster"], confirms: [true] })
  const steered: unknown[] = []
  const killed: unknown[] = []
  const mesh = {
    ...fixture.mesh,
    steer: async (input: unknown) => {
      steered.push(input)
      return { ok: true as const, value: { delivered: 1 } }
    },
    kill: async (input: unknown) => {
      killed.push(input)
      return { ok: true as const, value: { killed: 1 } }
    },
  }
  const app = await mount(
    () => (
      <Grove
        context={recorded.context}
        sessionID="ses_root"
        mesh={mesh}
      />
    ),
    { width: 120, height: 30 },
  )
  await app.renderOnce()
  try {
    expect(await recorded.press("Steer selected agent")).toBe(true)
    expect(steered[0]).toMatchObject({ parentSessionID: "ses_root", targetAgent: "explore" })
    expect(await recorded.press("Kill selected agent")).toBe(true)
    expect(killed[0]).toMatchObject({ parentSessionID: "ses_root", targetSessionID: "ses_explore" })
  } finally {
    app.renderer.destroy()
  }
})

test("an idle grove subscribes to nothing: no timers without work", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const fixture = groveFixture({ specs: [{ ...STATES[2]!, state: "done" }] })
  const app = await render(fixture, { width: 120, height: 30, ticker })
  try {
    await app.renderOnce()
    expect(ticker.subscribers()).toBe(0)
    expect(ticker.running()).toBe(false)
    expect(clock.scheduled()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("animations off shows final panes immediately and schedules nothing", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => false, ...clock.options })
  const fixture = groveFixture({ specs: [STATES[0]!], animations: false })
  const app = await render(fixture, { width: 100, height: 30, ticker })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Trace how the installer")
    expect(frame).toContain("3 tools")
    expect(frame).not.toContain("⢀")
    expect(ticker.running()).toBe(false)
    expect(clock.scheduled()).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a spawning agent grows its branch before its pane unfolds", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const fixture = groveFixture({ specs: [STATES[0]!], animations: true })
  const app = await render(fixture, { width: 100, height: 30, ticker })
  try {
    await app.renderOnce()
    const start = app.captureCharFrame()
    expect(start).not.toContain("Trace how the installer")

    clock.tick(450)
    await app.renderOnce()
    const branch = app.captureCharFrame()
    expect(branch).not.toContain("Trace how the installer")

    clock.tick(900)
    await app.renderOnce()
    const grown = app.captureCharFrame()
    expect(grown).toContain("explore")
    expect(grown).toContain("Trace how the installer")
    expect(grown).toContain("3 tools")
  } finally {
    app.renderer.destroy()
  }
})

test("the shared ticker drives the running spinner and its current tool", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const fixture = groveFixture({ specs: [STATES[0]!], animations: true })
  const app = await render(fixture, { width: 100, height: 30, ticker })
  try {
    clock.tick(1_200)
    await app.renderOnce()
    const first = app.captureCharFrame()
    clock.tick(1_000)
    await app.renderOnce()
    const second = app.captureCharFrame()
    expect(first).not.toBe(second)
    expect(second).toContain("grep optionalDependencies")
  } finally {
    app.renderer.destroy()
  }
})

test("an empty session says there are no subagents instead of inventing them", async () => {
  const fixture = groveFixture({ specs: [] })
  const app = await render(fixture, { width: 120, height: 24 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("no branches yet")
    expect(frame).toContain("No subagents for this session")
    expect(frame).not.toContain("ACTIVE")
  } finally {
    app.renderer.destroy()
  }
})

test("the overflow row scrolls horizontally", async () => {
  const specs = Array.from({ length: 12 }, (_, index): GroveSpec => ({
    id: `ses_${index}`,
    agent: "explore",
    title: `branch ${index}`,
    state: "done",
    created: 1_000 + index,
  }))
  const fixture = groveFixture({ specs })
  const app = await render(fixture, { width: 100, height: 40 })
  try {
    const scroll = app.renderer.root.findDescendantById("banyancode.grove.overflow") as unknown as ScrollBoxRenderable
    expect(scroll).toBeDefined()
    expect(scroll.scrollWidth ?? 0).toBeGreaterThan(0)
  } finally {
    app.renderer.destroy()
  }
})

test("the agents panel renders the understory as its main view", async () => {
  const fixture = groveFixture({ specs: STATES })
  const app = await mount(
    () => (
      <InspectorPanel
        context={fixture.context}
        live={live({ mesh: fixture.mesh })}
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
    { width: 120, height: 30 },
  )
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("RUN")
    expect(frame).toContain("explore")
    expect(frame).not.toContain("branches growing")
  } finally {
    app.renderer.destroy()
  }
})

test("the grouped overflow entry can be expanded from the keyboard", async () => {
  const specs = Array.from({ length: 8 }, (_, index): GroveSpec => ({
    id: `ses_${index}`,
    agent: "explore",
    title: `branch ${index}`,
    state: "running",
    created: 1_000 + index,
  }))
  const fixture = groveFixture({ specs })
  const recorded = fixtureContext({ base: fixture.context })
  const app = await render(fixture, { width: 100, height: 40, context: recorded.context })
  try {
    expect(await recorded.press("Next row")).toBe(true)
    expect(await recorded.press("Next row")).toBe(true)
    expect(await recorded.press("Run action")).toBe(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("collapsed")
    expect(await recorded.press("Collapse agent groups")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
