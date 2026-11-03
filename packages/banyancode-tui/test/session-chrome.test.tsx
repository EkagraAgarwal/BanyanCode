/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { SessionFooter, SessionHeader } from "../src/components/status/session-chrome"
import { PANEL } from "../src/constants"
import { createTicker, type Ticker } from "../src/motion"
import { codegraphLive, context, meshLive, mount, session, systemLive, theme } from "./harness"

function fakeClock() {
  const timers = new Map<number, () => void>()
  let next = 1
  let scheduled = 0
  let cleared = 0
  let now = 0
  return {
    options: {
      now: () => now,
      setInterval: ((fn: () => void) => {
        const id = next++
        timers.set(id, fn)
        scheduled++
        return id as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: ((id: unknown) => {
        if (timers.delete(id as number)) cleared++
      }) as unknown as typeof clearInterval,
    },
    advance(ms: number) {
      now += ms
      for (const fn of [...timers.values()]) fn()
    },
    scheduled: () => scheduled,
    cleared: () => cleared,
    live: () => timers.size,
  }
}

const root = session({ id: "ses_root", title: "root" })
const child = session({ id: "ses_child", parentID: "ses_root", title: "worker", agent: "coder" })

const message = {
  id: "msg_a",
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "model" },
  time: { created: 1_000, completed: 2_000 },
  tokens: { input: 40_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
  content: [{ type: "text", text: "answer" }],
} as unknown as SessionMessageInfo

const models = [
  { providerID: "test", id: "model", limit: { context: 100_000, output: 8_000 } },
] as unknown as ModelInfo[]

const idle = context({ sessions: [root] })
const busyContext = {
  sessions: [root, child],
  running: new Set(["ses_child"]),
  messages: { ses_root: [message] },
  models,
}
// The Trunk chrome is opt-in now: its tests ask for it the way a user would.
const trunkIdle = context({ sessions: [root], layout: "trunk" })
const trunkBusy = context({ ...busyContext, layout: "trunk" })

const codegraph = codegraphLive({ readiness: { reason: "ready", autoBuilt: false } })

/**
 * The harness theme gives every token the same colour, which hides a
 * colour-only animation. This variant separates the rule from the highlight.
 */
function distinctColors(value: Context): Context {
  return {
    ...value,
    theme: {
      ...theme,
      border: { ...theme.border, base: RGBA.fromInts(20, 20, 20) },
      growth: { ...theme.growth, highlight: RGBA.fromInts(200, 240, 120), leaf: RGBA.fromInts(120, 200, 140) },
    },
  } as unknown as Context
}

const lines = (app: { captureCharFrame(): string }) => app.captureCharFrame().split("\n")
const canopyColors = (app: { captureSpans(): { lines: Array<{ spans: Array<{ fg: RGBA }> }> } }) =>
  (app.captureSpans().lines[1]?.spans ?? []).map((span) => span.fg.toInts().join(","))

async function renderHeader(options: {
  readonly width: number
  readonly ctx?: Context
  readonly ticker?: Ticker
}) {
  return mount(
    () => (
      <SessionHeader
        context={options.ctx ?? idle}
        sessionID="ses_root"
        codegraph={codegraph}
        mesh={meshLive()}
        system={systemLive()}
        ticker={options.ticker}
      />
    ),
    { width: options.width, height: 4 },
  )
}

function pendingContext(permissions: number): Context {
  const base = context({ sessions: [root], layout: "trunk" })
  return {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: () => Array.from({ length: permissions }, (_, index) => ({ id: `perm_${index}` })),
        },
      },
    },
  } as unknown as Context
}

test("the classic layout is the default and draws the v1 chrome", async () => {
  const app = await renderHeader({ width: 160 })
  try {
    const [row0, tabs, rule] = lines(app)
    expect(row0).toContain("BANYANCODE")
    expect(row0).toContain("workspace")
    expect(row0).toContain("● 0 active")
    expect(row0).toContain("● LSP")
    expect(row0).toContain("Graph: built")
    expect(row0).toContain("ctrl+p commands ctrl+] tabs")
    expect(row0).not.toContain("CHAT")
    // The tab row and its full-width rule sit under the brand row, not a canopy.
    expect(tabs).toContain("CHAT")
    expect(tabs).toContain("SESSIONS")
    expect(tabs).toContain("AGENTS")
    expect(tabs).toContain("CONFIG")
    expect(rule!.replace(/[─\s]/g, "")).toBe("")
    expect(app.captureCharFrame()).not.toContain("━")
    expect(app.captureCharFrame()).not.toContain("⣴⣿⣦")
  } finally {
    app.renderer.destroy()
  }
})

test("row 0 carries every status exactly once on the right", async () => {
  const app = await renderHeader({ width: 160, ctx: trunkBusy })
  try {
    const [row0, canopy] = lines(app)
    expect(row0).toContain("banyancode")
    expect(row0).toContain("workspace")
    for (const label of ["CHAT", "SESSIONS", "AGENTS", "CONFIG"]) expect(row0).toContain(label)
    expect(row0).toContain("◉ 1 agent")
    expect(row0).toContain("ctx 41%")
    expect(row0).toContain("Graph: built")
    expect(row0).toContain("● LSP")
    expect(row0).not.toContain("ctrl+p")
    // The canopy is row 1 and is a rule, not a second line of labels.
    expect(canopy!.replace(/[─━\s]/g, "")).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("row 0 keeps every tab and never wraps, down to a narrow terminal", async () => {
  for (const width of [160, 120, 80, 44]) {
    const app = await renderHeader({ width, ctx: trunkIdle })
    try {
      const [row0, row1] = lines(app)
      for (const label of ["CHAT", "SESSIONS", "AGENTS", "CONFIG"]) expect(row0).toContain(label)
      expect(row1!.replace(/[─━\s]/g, "")).toBe("")
      expect(row0!.length).toBeLessThanOrEqual(width)
    } finally {
      app.renderer.destroy()
    }
  }
  const narrow = await renderHeader({ width: 44, ctx: trunkIdle })
  try {
    const [row0] = lines(narrow)
    // The brand name is the first thing to go, so the tabs keep their room.
    expect(row0).not.toContain("banyancode")
    expect(row0).not.toContain("Graph")
  } finally {
    narrow.renderer.destroy()
  }
})

test("very narrow chrome keeps only the active tab", async () => {
  const base = context({ sessions: [root], layout: "trunk" })
  const onAgents = {
    ...base,
    ui: { ...base.ui, panel: { ...base.ui.panel, current: () => ({ name: PANEL.agents }) } },
  } as unknown as Context
  const app = await renderHeader({ width: 30, ctx: onAgents })
  try {
    const [row0] = lines(app)
    expect(row0).toContain("AGENTS")
    expect(row0).not.toContain("CHAT")
    expect(row0).not.toContain("SESSIONS")
  } finally {
    app.renderer.destroy()
  }
})

test("an idle header subscribes no timer", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const app = await renderHeader({ width: 120, ctx: trunkIdle, ticker })
  try {
    expect(ticker.subscribers()).toBe(0)
    expect(ticker.running()).toBe(false)
    expect(clock.scheduled()).toBe(0)
  } finally {
    app.renderer.destroy()
    ticker.dispose()
  }
})

test("a busy header shares one timer and the canopy moves", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const app = await renderHeader({ width: 120, ctx: distinctColors(trunkBusy), ticker })
  try {
    expect(clock.scheduled()).toBe(1)
    expect(ticker.subscribers()).toBe(1)
    const before = canopyColors(app)
    const frameBefore = lines(app)[1]!
    clock.advance(500)
    await app.renderOnce()
    const after = canopyColors(app)
    expect(after).not.toEqual(before)
    // Characters stay a rule; the movement is the highlight colour.
    expect(lines(app)[1]).toBe(frameBefore)
    expect(lines(app)[1]!.replace(/[─━\s]/g, "")).toBe("")
    expect(lines(app)[1]).toContain("━")
  } finally {
    app.renderer.destroy()
    ticker.dispose()
  }
})

test("animations off means no timer even while busy", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => false, ...clock.options })
  const app = await renderHeader({ width: 120, ctx: trunkBusy, ticker })
  try {
    expect(clock.scheduled()).toBe(0)
    const before = lines(app)[1]!
    clock.advance(500)
    await app.renderOnce()
    expect(lines(app)[1]).toBe(before)
  } finally {
    app.renderer.destroy()
    ticker.dispose()
  }
})

async function renderFooter(options: { readonly width: number; readonly ctx?: Context }) {
  return mount(
    () => (
      <SessionFooter
        context={options.ctx ?? trunkIdle}
        sessionID="ses_root"
        mesh={meshLive()}
        system={systemLive()}
      />
    ),
    { width: options.width, height: 2 },
  )
}

test("the classic footer always shows the attention count and the v1 hint", async () => {
  const app = await renderFooter({ width: 120, ctx: idle })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("workspace · Git: v2-base")
    expect(frame).toContain("▲ 0 need attention")
    expect(frame).toContain("^p cmd · / search")
    expect(frame).not.toContain("^p commands")
  } finally {
    app.renderer.destroy()
  }
})

test("the classic footer names the waiting count in the error colour", async () => {
  const waiting = await renderFooter({ width: 120, ctx: pendingContext(2) })
  try {
    expect(waiting.captureCharFrame()).toContain("▲ 2 need attention")
  } finally {
    waiting.renderer.destroy()
  }
})

test("the Trunk bottom row shows the location, branch and one key hint", async () => {
  const app = await renderFooter({ width: 120 })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("workspace · Git: v2-base")
    expect(frame).toContain("^p commands")
    expect(frame).toContain("^] tabs")
    expect(frame).not.toContain("ctrl+p")
    expect(frame).not.toContain("need attention")
    expect(frame).not.toContain("0 need attention")
  } finally {
    app.renderer.destroy()
  }
})

test("Trunk attention appears only while something is waiting", async () => {
  const waiting = await renderFooter({ width: 120, ctx: pendingContext(2) })
  const clear = await renderFooter({ width: 120 })
  try {
    expect(waiting.captureCharFrame()).toContain("▲ 2 need attention")
    expect(clear.captureCharFrame()).not.toContain("need attention")
  } finally {
    waiting.renderer.destroy()
    clear.renderer.destroy()
  }
})

/** The same host context, with the Agents panel open and focused. */
function agentsPanel(base: Context): Context {
  return {
    ...base,
    ui: {
      ...base.ui,
      panel: {
        ...base.ui.panel,
        current: () => ({
          name: PANEL.agents,
          sessionID: "ses_root",
          width: 120,
          presentation: "main",
          focused: true,
          focus: () => {},
          close: () => {},
          toggleFullscreen: () => {},
        }),
      },
    },
  } as Context
}

test("the Trunk footer leaves the attention count to the Agents tab's status row", async () => {
  const onChat = await renderFooter({ width: 120, ctx: pendingContext(2) })
  const onAgents = await renderFooter({ width: 120, ctx: agentsPanel(pendingContext(2)) })
  try {
    // Chat keeps the count on the footer, exactly as before.
    expect(onChat.captureCharFrame()).toContain("▲ 2 need attention")
    // The Agents tab prints it on its own status row; the footer drops it so
    // the tab's hint row plus the footer are the mockup's rows -2 and -1.
    const frame = onAgents.captureCharFrame()
    expect(frame).not.toContain("need attention")
    expect(frame).toContain("workspace · Git: v2-base")
  } finally {
    onChat.renderer.destroy()
    onAgents.renderer.destroy()
  }
})

test("narrow Trunk chrome drops the key hint but keeps the attention message", async () => {
  const app = await renderFooter({ width: 44, ctx: pendingContext(1) })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("▲ 1 need attention")
    expect(frame).not.toContain("^p")
  } finally {
    app.renderer.destroy()
  }
})

/** A context whose selected panel is `name`, with the classic chat layout. */
function onPanel(name: string): Context {
  const base = context({ sessions: [root] })
  return {
    ...base,
    ui: { ...base.ui, panel: { ...base.ui.panel, current: () => ({ name }) } },
  } as unknown as Context
}

test("the Agents tab wears the canopy chrome even in the classic layout", async () => {
  const agents = onPanel(PANEL.agents)
  const header = await renderHeader({ width: 160, ctx: agents })
  try {
    const [row0, canopy] = lines(header)
    // Brand and tabs share row 0, then the canopy rule: no v1 tab row.
    expect(row0).toContain("banyancode")
    for (const label of ["CHAT", "SESSIONS", "AGENTS", "CONFIG"]) expect(row0).toContain(label)
    expect(row0).not.toContain("BANYANCODE")
    expect(canopy!.replace(/[─━\s]/g, "")).toBe("")
    expect(canopy).toContain("━")
    expect(header.captureCharFrame()).not.toContain("ctrl+p commands ctrl+] tabs")
  } finally {
    header.renderer.destroy()
  }
  const footer = await renderFooter({ width: 120, ctx: agents })
  try {
    const frame = footer.captureCharFrame()
    expect(frame).toContain("^p commands")
    // The classic "▲ 0 need attention" is not part of the canopy chrome.
    expect(frame).not.toContain("need attention")
  } finally {
    footer.renderer.destroy()
  }
})

test("Sessions, Config and Chat keep the classic chrome", async () => {
  for (const name of [PANEL.sessions, PANEL.config]) {
    const app = await renderHeader({ width: 160, ctx: onPanel(name) })
    try {
      const [row0, tabs] = lines(app)
      expect(row0).toContain("BANYANCODE")
      expect(tabs).toContain("AGENTS")
    } finally {
      app.renderer.destroy()
    }
    const footer = await renderFooter({ width: 120, ctx: onPanel(name) })
    try {
      expect(footer.captureCharFrame()).toContain("▲ 0 need attention")
    } finally {
      footer.renderer.destroy()
    }
  }
})
