/** @jsxImportSource @opentui/solid */
/**
 * Rendering-cost guards for the Agents tab. Every assertion is a count, never a
 * wall-clock time: these catch a return to "redraw everything on every event"
 * without depending on the machine the suite runs on.
 *
 * The manual benchmarks in `perf-bench/` are NOT part of this run.
 */
import { expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { OptimizedBuffer } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, type Accessor, type Setter } from "solid-js"
import { Understory } from "../src/components/understory"
import { CELL_GRID_STATS, Grid } from "../src/components/understory/cells"
import { messageSpans, resetSpanStats, SPAN_STATS, tokenBuckets } from "../src/data/understory-spans"
import type { MeshNode } from "../src/data/pending-rpc"
import { createTicker } from "../src/motion"
import { context, meshLive, meshNode, session } from "./harness"

const AGENTS = 20
const START = 1_700_000_000_000

const message = (sessionID: string, index: number, at: number, open: boolean): SessionMessageInfo => ({
  id: `${sessionID}_m${index}`,
  type: "assistant",
  time: { created: at, completed: at + 900, streamed: at },
  agent: "coder",
  model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
  content: [
    { type: "text", text: `step ${index} of the task`, time: { created: at } },
    {
      type: "tool",
      id: `${sessionID}_t${index}`,
      name: "read",
      state: { status: "completed", input: { filePath: "packages/tui/src/app.tsx" }, output: "", metadata: {} },
      time: { created: at + 100, completed: at + 800 },
    },
    {
      type: "tool",
      id: `${sessionID}_t${index}b`,
      name: "bash",
      state: open
        ? { status: "running", input: { command: "bun typecheck" }, metadata: {} }
        : { status: "completed", input: { command: "bun typecheck" }, output: "", metadata: {} },
      time: { created: at + 200, ...(open ? {} : { completed: at + 850 }) },
    },
  ],
  tokens: { input: 900, output: 220, reasoning: 60, cache: { read: 0, write: 0 } },
}) as unknown as SessionMessageInfo

interface Fixture {
  readonly sessions: SessionInfo[]
  readonly initial: Record<string, readonly SessionMessageInfo[]>
  readonly mesh: ReturnType<typeof meshLive>
}

/** `live` branches whose last two messages hold an open tool call. */
function fixture(count: number, messagesEach: number, live: number): Fixture {
  const sessions = Array.from({ length: count }, (_, index) =>
    session({
      id: `ses_${index}`,
      parentID: "ses_root",
      agent: index % 2 === 0 ? "coder" : "explore",
      time: { created: START + index * 1_000, updated: START + index * 1_000 + messagesEach * 1_000 },
    }),
  )
  const initial: Record<string, readonly SessionMessageInfo[]> = {
    ses_root: [message("ses_root", 1, START + 500, false)],
  }
  sessions.forEach((info, index) => {
    const list: SessionMessageInfo[] = []
    for (let m = 1; m <= messagesEach; m += 1) {
      list.push(message(info.id, m, START + index * 1_000 + m * 1_000, index < live && m > messagesEach - 2))
    }
    initial[info.id] = list
  })
  const root = meshNode({
    sessionID: "ses_root",
    agent: "build",
    state: live > 0 ? "running" : "idle",
    createdAt: START,
    children: sessions.map((info, index) =>
      meshNode({
        sessionID: info.id,
        agent: info.agent,
        state: index < live ? "running" : "idle",
        createdAt: info.time.created,
        children: [],
      }),
    ),
  })
  return { sessions, initial, mesh: meshLive({ root: root as MeshNode, maxSubagents: 12 }) }
}

interface Mounted {
  readonly app: Awaited<ReturnType<typeof testRender>>
  readonly ticker: ReturnType<typeof createTicker>
  readonly list: () => number
  readonly delta: (id: string, next: SessionMessageInfo) => void
  readonly tick: () => void
  readonly clock: () => number
}

async function mountTabs(data: Fixture, options: { live: number; perSession: boolean; animations?: boolean }) {
  const [record, setRecord] = createSignal<Readonly<Record<string, readonly SessionMessageInfo[]>>>(data.initial)
  const perSession = new Map<
    string,
    [Accessor<readonly SessionMessageInfo[]>, Setter<readonly SessionMessageInfo[]>]
  >(Object.entries(data.initial).map(([id, list]) => [id, createSignal<readonly SessionMessageInfo[]>(list)]))
  let reads = 0
  const list = (id: string) => {
    reads += 1
    return options.perSession ? (perSession.get(id)?.[0]() ?? []) : (record()[id] ?? [])
  }
  const base = context({ sessions: [session({ id: "ses_root", agent: "build", time: { created: START, updated: START + 1 } }), ...data.sessions], animations: options.animations ?? true })
  const value = {
    ...base,
    data: {
      ...base.data,
      session: {
        ...base.data.session,
        message: { ...base.data.session.message, list, get: () => undefined },
      },
    },
  } as unknown as typeof base

  let clock = START + 400 * 1_000
  let interval: (() => void) | undefined
  const ticker = createTicker({
    animations: () => options.animations ?? true,
    now: () => clock,
    setInterval: ((fn: () => void) => {
      interval = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      interval = undefined
    }) as unknown as typeof clearInterval,
  })

  const app = await testRender(
    () => (
      <Understory
        context={value}
        sessionID="ses_root"
        mesh={data.mesh}
        ticker={ticker}
        now={() => clock}
        width={168}
        timers={{
          setTimeout: ((fn: () => void) => {
            void fn
            return 1 as unknown as ReturnType<typeof setTimeout>
          }) as unknown as typeof setTimeout,
          clearTimeout: (() => {}) as typeof clearTimeout,
        }}
      />
    ),
    { width: 168, height: 48, nativeSceneVerify: false },
  )
  await app.renderOnce()
  await app.renderOnce()
  return {
    app,
    ticker,
    list: () => reads,
    delta: (id: string, next: SessionMessageInfo) => {
      if (options.perSession) {
        const signal = perSession.get(id)!
        signal[1]([...signal[0](), next])
        return
      }
      const current = record()
      setRecord({ ...current, [id]: [...(current[id] ?? []), next] })
    },
    tick: () => {
      clock += 1_000 / 12
      interval?.()
    },
    clock: () => clock,
  } satisfies Mounted
}

// --- FFI paint counters --------------------------------------------------------
let ffiSetCell = 0
let ffiFrame = 0
{
  const proto = OptimizedBuffer.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  const setCell = proto.setCell!
  proto.setCell = function (...args: unknown[]) {
    ffiSetCell += 1
    return setCell.apply(this, args)
  }
  const drawFrameBuffer = proto.drawFrameBuffer!
  proto.drawFrameBuffer = function (...args: unknown[]) {
    ffiFrame += 1
    return drawFrameBuffer.apply(this, args)
  }
}

let gridSetCell = 0
{
  const proto = Grid.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  const setCell = proto.setCell!
  proto.setCell = function (...args: unknown[]) {
    gridSetCell += 1
    return setCell.apply(this, args)
  }
}

const resetCounters = () => {
  ffiSetCell = 0
  ffiFrame = 0
  gridSetCell = 0
}

test("a 2000-message session's buckets only read the window, not the history", () => {
  const messages: SessionMessageInfo[] = []
  for (let index = 1; index <= 2000; index += 1) messages.push(message("ses_long", index, START + index * 1_000, false))
  const spans = messageSpans(messages)
  resetSpanStats()
  const to = START + 2000 * 1_000
  const buckets = tokenBuckets(spans, messages, to - 20_000, to, 90)
  expect(buckets).toHaveLength(90)
  // Twenty seconds of a one-message-per-second session: a couple of dozen
  // messages, not two thousand. A linear scan would report buckets of 2000.
  expect(SPAN_STATS.bucketMessages).toBeLessThan(40)

  // The whole history is still summed when the window really is the whole run.
  resetSpanStats()
  tokenBuckets(spans, messages, 0, to, 90)
  expect(SPAN_STATS.bucketMessages).toBe(2000)
})

test("one streamed part re-reads only the session that changed", async () => {
  const data = fixture(AGENTS, 200, 8)
  const mounted = await mountTabs(data, { live: 8, perSession: true })
  try {
    const before = mounted.list()
    mounted.delta("ses_3", message("ses_3", 201, mounted.clock(), true))
    await mounted.app.renderOnce()
    // One message list read for the changed branch, not ten per branch. The
    // measured baseline was 203 reads at twenty agents.
    const reads = mounted.list() - before
    expect(reads).toBeLessThanOrEqual(5)
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("a coarse store still bounds the reads per delta to one pass", async () => {
  const data = fixture(AGENTS, 200, 8)
  const mounted = await mountTabs(data, { live: 8, perSession: false })
  try {
    const before = mounted.list()
    mounted.delta("ses_3", message("ses_3", 201, mounted.clock(), true))
    await mounted.app.renderOnce()
    const reads = mounted.list() - before
    // A record-wide store invalidates every branch's memo: one read per branch,
    // never the 203 of ten passes per branch.
    expect(reads).toBeLessThanOrEqual(AGENTS * 2)
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("a finished run holds no ticker, and a frame draws nothing", async () => {
  const data = fixture(AGENTS, 40, 0)
  const mounted = await mountTabs(data, { live: 0, perSession: true })
  try {
    for (let index = 0; index < 4; index += 1) await mounted.app.renderOnce()
    expect(mounted.ticker.subscribers()).toBe(0)
    expect(mounted.ticker.running()).toBe(false)

    resetCounters()
    CELL_GRID_STATS.uploads = 0
    mounted.tick()
    await mounted.app.renderOnce()
    // Nothing is live, so not even a tick reaches a grid: no cells drawn, no
    // upload, no per-cell FFI call.
    expect(gridSetCell).toBe(0)
    expect(CELL_GRID_STATS.uploads).toBe(0)
    expect(ffiSetCell).toBe(0)
    // The paint is one composite per grid, whatever the lens size.
    expect(ffiFrame).toBeLessThanOrEqual(5)
  } finally {
    mounted.app.renderer.destroy()
  }
})

test("a live tick repaints through bulk composites, not per-cell FFI", async () => {
  const data = fixture(AGENTS, 200, 8)
  const mounted = await mountTabs(data, { live: 8, perSession: true })
  try {
    expect(mounted.ticker.subscribers()).toBeGreaterThan(0)
    for (let index = 0; index < 3; index += 1) {
      mounted.tick()
      await mounted.app.renderOnce()
    }
    resetCounters()
    CELL_GRID_STATS.uploads = 0
    mounted.tick()
    await mounted.app.renderOnce()
    // A tick animates the roster's spinner and the open lane edges; the grids
    // upload at most their own planes and composite once each.
    expect(ffiSetCell).toBe(0)
    expect(ffiFrame).toBeLessThanOrEqual(5)
    expect(CELL_GRID_STATS.uploads).toBeLessThanOrEqual(3)
    // And the frame is a diff of the visible cells, not a full-screen repaint.
    expect(gridSetCell).toBeLessThan(168 * 48)
  } finally {
    mounted.app.renderer.destroy()
  }
})
