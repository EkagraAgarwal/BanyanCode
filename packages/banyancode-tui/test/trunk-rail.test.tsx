/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { createTicker } from "../src/motion"
import { TRUNK_RAIL_MIN_WIDTH, trunkCapacity, trunkRows, type TrunkBranch } from "../src/components/trunk/layout"
import { TrunkRail, TrunkSurface } from "../src/components/trunk/trunk"
import { context, meshLive, meshNode, mount, session, usageLive } from "./harness"

const ROOT = "ses_root"
/** One fixed "now" for every fixture, so ages are exact rather than drifting. */
const NOW = 1_700_000_000_000

type ChildFixture = {
  readonly agent: string
  readonly state?: "running" | "idle" | "failed" | "interrupted"
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly tokens?: number
}

function tool(name: string, args: string, status: "running" | "completed" = "running"): SessionMessageInfo {
  return {
    id: `msg_${name}`,
    type: "assistant",
    time: { created: NOW - 2_000 },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    content: [
      {
        type: "tool",
        id: `tool_${name}`,
        name,
        state: { status, input: { filePath: args }, output: "", metadata: {} },
        time: { created: NOW - 1_000 },
      },
    ],
  } as unknown as SessionMessageInfo
}

function text(value: string): SessionMessageInfo {
  return {
    id: "msg_text",
    type: "assistant",
    time: { created: NOW - 2_000, completed: NOW - 1_000 },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    content: [{ type: "text", text: value }],
  } as unknown as SessionMessageInfo
}

/** A harness context whose named children are blocked on a permission. */
function withPending(base: Context, sessionIDs: readonly string[]): Context {
  return {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        permission: {
          ...base.data.session.permission,
          list: (id: string) => (sessionIDs.includes(id) ? [{ id: `per_${id}` }] : []),
        },
      },
    },
  } as unknown as Context
}

function fixture(input: {
  readonly children: readonly ChildFixture[]
  readonly messages?: Readonly<Record<string, readonly SessionMessageInfo[]>>
  readonly killed?: readonly string[]
  readonly runningRoot?: boolean
  readonly pending?: readonly string[]
  readonly animations?: boolean
}): { context: Context; mesh: ReturnType<typeof meshLive>; sessionID: string } {
  const children = input.children.map((child, index) =>
    meshNode({
      sessionID: `ses_c${index}`,
      agent: child.agent,
      state: child.state ?? "running",
      cost: 0,
      createdAt: child.createdAt ?? NOW - 4_000,
      updatedAt: child.updatedAt ?? NOW - 4_000,
      tokens: {
        input: child.tokens ?? 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  )
  const mesh = meshLive({
    root: meshNode({
      sessionID: ROOT,
      state: input.runningRoot ? "running" : "idle",
      createdAt: NOW - 60_000,
      children,
    }),
    killed: input.killed,
  })
  const base = context({
    sessions: [session({ id: ROOT })],
    messages: input.messages,
    running: new Set(input.runningRoot ? [ROOT] : []),
    animations: input.animations ?? false,
  })
  return {
    context: input.pending === undefined ? base : withPending(base, input.pending),
    mesh,
    sessionID: ROOT,
  }
}

/** The four states one rail has to show at once. */
function everyState() {
  return fixture({
    children: [
      { agent: "explore", state: "running" },
      { agent: "scout", state: "running" },
      { agent: "coder", state: "running" },
      { agent: "reviewer", state: "idle" },
      { agent: "breaker", state: "failed" },
    ],
    killed: ["ses_c2"],
    pending: ["ses_c1"],
    messages: {
      ses_c0: [tool("edit", "packages/opencode/script/postinstall.mjs")],
      ses_c3: [text("npm.cmd needs shell:true on win32")],
    },
  })
}

test.each([
  { width: 168, height: 48 },
  { width: 120, height: 40 },
  { width: 200, height: 55 },
])("rail renders its trunk and branches at $width×$height", async ({ width, height }) => {
  const data = everyState()
  const app = await mount(
    () => (
      <TrunkSurface
        context={data.context}
        sessionID={data.sessionID}
        mesh={data.mesh}
        terminalWidth={width}
        terminalHeight={height}
        now={() => NOW}
      />
    ),
    { width, height },
  )
  try {
    const frame = app.captureCharFrame()
    const lines = frame.replace(/\n$/, "").split("\n")
    expect(lines).toHaveLength(height)
    // Root node at the top, trunk below it.
    expect(lines[0]).toContain("◉")
    expect(frame).toContain("explore")
    expect(frame).toContain("reviewer")
    expect(frame).toContain("│")
    expect(frame).toContain("┤")
  } finally {
    app.renderer.destroy()
  }
})

test("the rail carries the gateway summary when usage is available", async () => {
  const data = everyState()
  const app = await mount(
    () => (
      <TrunkRail
        context={data.context}
        sessionID={data.sessionID}
        mesh={data.mesh}
        width={40}
        height={20}
        now={() => NOW}
        usage={usageLive({
          tools: [{ toolId: "code_find", useCount: 12, lastUsedAt: 1_000 }],
          gateway: {
            rows: [
              { fromTool: "grep", toTool: "code_find", route: "swapped", useCount: 12, bytesSaved: 0, lastUsedAt: 1_000 },
            ],
            summary: { swapped: 12, fallback: 5, augmented: 0, direct: 18, bytesSaved: 184_320 },
          },
        })}
      />
    ),
    { width: 40, height: 20 },
  )
  try {
    const frame = app.captureCharFrame()
    // The rail is narrow: the summary drops to the compact spelling instead of clipping.
    expect(frame).toContain("12⇢ 5↩ 18 raw ~180 KB")
  } finally {
    app.renderer.destroy()
  }
})

test("the narrow form drops the rail for a pill row", async () => {  expect(100).toBeLessThan(TRUNK_RAIL_MIN_WIDTH)
  const data = everyState()
  const app = await mount(
    () => (
      <TrunkSurface
        context={data.context}
        sessionID={data.sessionID}
        mesh={data.mesh}
        terminalWidth={100}
        terminalHeight={30}
        now={() => NOW}
      />
    ),
    { width: 100, height: 30 },
  )
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("explore")
    expect(frame).not.toContain("┤")
    expect(frame).not.toContain("◉")
  } finally {
    app.renderer.destroy()
  }
})

test("branch states read as running, waiting, done, failed and killed", async () => {
  const data = everyState()
  const app = await mount(
    () => (
      <TrunkRail
        context={data.context}
        sessionID={data.sessionID}
        mesh={data.mesh}
        width={48}
        height={30}
        now={() => NOW}
      />
    ),
    { width: 48, height: 30 },
  )
  try {
    const frame = app.captureCharFrame()
    // Waiting breathes with the attention glyph, not a check.
    expect(frame).toContain("scout")
    expect(frame).toContain("!")
    expect(frame).toContain("waiting for you")
    // A returned summary, and nothing invented when there is none.
    expect(frame).toContain("npm.cmd needs shell:true on win32")
    // Killed and failed never look finished.
    expect(frame).toContain("breaker")
    expect(frame).toContain("✕")
    expect(frame).toContain("failed")
    expect(frame).toContain("killed")
    // The running branch shows the tool it is running.
    expect(frame).toContain("edit")
    expect(frame).toContain("postinstall.mjs")
  } finally {
    app.renderer.destroy()
  }
})

test("a finished branch leaves the rail after seven seconds", async () => {
  const fresh = fixture({
    children: [{ agent: "explore", state: "idle", updatedAt: NOW - 1_000 }],
    messages: { ses_c0: [text("patched, 214 tests pass")] },
  })
  const stale = fixture({
    children: [{ agent: "explore", state: "idle", updatedAt: NOW - 8_000 }],
    messages: { ses_c0: [text("patched, 214 tests pass")] },
  })
  const render = async (data: ReturnType<typeof fixture>) => {
    const app = await mount(
      () => (
        <TrunkRail
          context={data.context}
          sessionID={data.sessionID}
          mesh={data.mesh}
          width={40}
          height={20}
          now={() => NOW}
        />
      ),
      { width: 40, height: 20 },
    )
    return { app, frame: app.captureCharFrame() }
  }
  const within = await render(fresh)
  try {
    expect(within.frame).toContain("explore")
    expect(within.frame).toContain("patched, 214 tests pass")
  } finally {
    within.app.renderer.destroy()
  }
  const expired = await render(stale)
  try {
    expect(expired.frame).not.toContain("explore")
  } finally {
    expired.app.renderer.destroy()
  }
})

test("twenty agents become running-first rows plus one +N more row", async () => {
  // Nineteen finished branches and one still running, spawned last: the running
  // one has to reach the rail and the tail has to become `+N more`.
  const children: ChildFixture[] = Array.from({ length: 20 }, (_, index) => ({
    agent: `agent${String(index).padStart(2, "0")}`,
    state: index === 19 ? "running" : "idle",
    createdAt: NOW - 5_000 + index * 100,
    updatedAt: NOW - 1_000,
  }))
  const data = fixture({ children })
  const height = 30
  const width = 37
  const capacity = trunkCapacity(height)
  const app = await mount(
    () => (
      <TrunkRail
        context={data.context}
        sessionID={data.sessionID}
        mesh={data.mesh}
        width={width}
        height={height}
        now={() => NOW}
      />
    ),
    { width, height },
  )
  try {
    const frame = app.captureCharFrame()
    const lines = frame.replace(/\n$/, "").split("\n")
    // Nothing overflows the column: every row fits the rail, every row is used at most once.
    expect(lines).toHaveLength(height)
    expect(frame).toContain("agent19")
    expect(frame).toContain("agent00")
    expect(frame).toContain(`+${20 - (capacity - 1)} more`)
    // The tail past the column's capacity is not drawn at all.
    expect(frame).not.toContain("agent18")
    expect(lines.filter((line) => line.includes("more")).length).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("clicking a branch opens that child session", async () => {
  const opened: unknown[] = []
  const data = fixture({ children: [{ agent: "explore", state: "running" }] })
  const withRouter = {
    ...data.context,
    ui: {
      ...data.context.ui,
      router: { ...data.context.ui.router, navigate: (destination: unknown) => opened.push(destination) },
    },
  } as unknown as Context
  const app = await mount(
    () => (
      <TrunkRail context={withRouter} sessionID={ROOT} mesh={data.mesh} width={40} height={20} now={() => NOW} />
    ),
    { width: 40, height: 20 },
  )
  try {
    // Row 2 is the first branch label: root, blank, branch.
    await app.mockMouse.click(4, 2)
    expect(opened).toEqual([{ type: "session", sessionID: "ses_c0" }])
  } finally {
    app.renderer.destroy()
  }
})

test("an idle rail holds no timer", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const data = fixture({ children: [] })
  const app = await mount(
    () => (
      <TrunkRail
        context={data.context}
        sessionID={ROOT}
        mesh={data.mesh}
        ticker={ticker}
        width={40}
        height={20}
        now={() => NOW}
      />
    ),
    { width: 40, height: 20 },
  )
  try {
    expect(ticker.running()).toBe(false)
    expect(clock.timers().live).toBe(0)
    expect(app.captureCharFrame()).toContain("◉")
  } finally {
    app.renderer.destroy()
    ticker.dispose()
  }
})

test("animations off subscribes nothing, even with a running branch", async () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => false, ...clock.options })
  const data = fixture({ children: [{ agent: "explore", state: "running" }], animations: false })
  const app = await mount(
    () => (
      <TrunkRail
        context={data.context}
        sessionID={ROOT}
        mesh={data.mesh}
        ticker={ticker}
        width={40}
        height={20}
        now={() => NOW}
      />
    ),
    { width: 40, height: 20 },
  )
  try {
    expect(clock.timers().scheduled).toBe(0)
    expect(ticker.subscribers()).toBe(0)
    // Final state, not an animation frame.
    const frame = app.captureCharFrame()
    expect(frame).toContain("explore")
    expect(frame).toContain("⋯")
  } finally {
    app.renderer.destroy()
    ticker.dispose()
  }
})

test("rows never overlap and stop at the column height", () => {
  const branches: TrunkBranch[] = Array.from({ length: 30 }, (_, index) => ({
    child: {
      sessionID: `ses_${index}`,
      agent: `agent${index}`,
      state: "running" as const,
      cost: 0,
      tokens: 0,
      createdAt: NOW - index,
      lastActivityAt: NOW - index,
      pending: 0,
    },
    killed: false,
    detail: "",
    ageMs: 1_000,
    settledMs: 0,
  }))
  for (const height of [6, 10, 20, 30, 48, 55]) {
    const rows = trunkRows({ height, branches })
    expect(rows).toHaveLength(height)
    expect(rows[0]!.kind).toBe("root")
    expect(rows[1]!.kind).toBe("blank")
    // A branch label always sits three rows under the previous label.
    const labels = rows.flatMap((row, index) => (row.kind === "branch" ? [index] : []))
    labels.forEach((row, index) => {
      if (index > 0) expect(row - labels[index - 1]!).toBe(3)
    })
    // The overflow row is the last label, never past the column.
    const more = rows.findIndex((row) => row.kind === "more")
    if (more >= 0) expect(more).toBeLessThan(height - 1)
  }
})

/** Records scheduled intervals so a test can count the rail's timers. */
function fakeClock(start = 0) {
  const timers = new Map<number, () => void>()
  let next = 1
  let scheduled = 0
  let cleared = 0
  let clock = start
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
        if (timers.delete(id as number)) cleared++
      }) as unknown as typeof clearInterval,
    },
    tick(ms: number) {
      clock += ms
      for (const fn of [...timers.values()]) fn()
    },
    timers: () => ({ scheduled, cleared, live: timers.size }),
  }
}
