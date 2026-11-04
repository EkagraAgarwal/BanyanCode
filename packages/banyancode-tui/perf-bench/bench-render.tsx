/** @jsxImportSource @opentui/solid */
/**
 * Real-component render benchmark for the Agents tab.
 *
 * Mounts the actual `Understory` shell (roster + lens + inspector) inside
 * opentui's headless test renderer, drives it with the same 12 fps tick the app
 * uses, and counts the work each frame really does: Grid cell writes, commit
 * scans, paint uploads, per-cell FFI calls, and the native encoder's own
 * cellsUpdated.
 *
 * Manual tool, not part of `bun test`:
 *   bun perf-bench/bench-render.tsx [agents] [messages] [cols] [rows]
 *   STORE=session   one message signal per session (what the host store does)
 *   STORE=record    one signal for the whole message record (worst case)
 *   FRAMES=n        frames per phase (default 60)
 */
import { OptimizedBuffer } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, type Accessor, type Setter } from "solid-js"
import type { SessionMessageInfo } from "@opencode/client"
import { Understory } from "../src/components/understory"
import { CELL_GRID_STATS, CellGridRenderable, Grid } from "../src/components/understory/cells"
import type { MeshNode } from "../src/data/pending-rpc"
import { createTicker } from "../src/motion"
import { context, meshLive, meshNode } from "../test/harness"
import { agents, message, rootSession, sessionInfo } from "./data"

const AGENTS = Number(process.argv[2] ?? 20)
const MESSAGES = Number(process.argv[3] ?? 200)
const COLS = Number(process.argv[4] ?? 168)
const ROWS = Number(process.argv[5] ?? 48)
const FRAMES = Number(process.env.FRAMES ?? 60)

// --- counters ------------------------------------------------------------------
const count = {
  gridSetCell: 0,
  gridClear: 0,
  gridText: 0,
  commit: 0,
  commitChanged: 0,
  renderSelf: 0,
  ffiSetCell: 0,
  ffiFrame: 0,
  upload: 0,
  listCalls: 0,
  selfMs: 0,
  selfCells: 0,
  commitMs: 0,
}
function reset() {
  count.gridSetCell = 0
  count.gridClear = 0
  count.gridText = 0
  count.commit = 0
  count.commitChanged = 0
  count.renderSelf = 0
  count.ffiSetCell = 0
  count.ffiFrame = 0
  count.upload = 0
  count.listCalls = 0
  count.selfMs = 0
  count.selfCells = 0
  count.commitMs = 0
}

{
  const grid = Grid.prototype as any
  const setCell = grid.setCell
  grid.setCell = function (...args: any[]) {
    count.gridSetCell += 1
    return setCell.apply(this, args)
  }
  const clear = grid.clear
  grid.clear = function (...args: any[]) {
    count.gridClear += 1
    return clear.apply(this, args)
  }
  const text = grid.text
  grid.text = function (...args: any[]) {
    count.gridText += 1
    return text.apply(this, args)
  }
  const proto = CellGridRenderable.prototype as any
  const commit = proto.commit
  if (commit !== undefined) {
    proto.commit = function (...args: any[]) {
      count.commit += 1
      const start = performance.now()
      const changed = commit.apply(this, args)
      count.commitMs += performance.now() - start
      if (changed) count.commitChanged += 1
      return changed
    }
  }
  const renderSelf = proto.renderSelf
  proto.renderSelf = function (...args: any[]) {
    count.renderSelf += 1
    count.selfCells += this.grid.width * this.grid.height
    const start = performance.now()
    const result = renderSelf.apply(this, args)
    count.selfMs += performance.now() - start
    return result
  }
  const buffer = OptimizedBuffer.prototype as any
  const bufferSetCell = buffer.setCell
  buffer.setCell = function (...args: any[]) {
    count.ffiSetCell += 1
    return bufferSetCell.apply(this, args)
  }
  const drawFrameBuffer = buffer.drawFrameBuffer
  buffer.drawFrameBuffer = function (...args: any[]) {
    count.ffiFrame += 1
    return drawFrameBuffer.apply(this, args)
  }
}

// --- data ----------------------------------------------------------------------
const specs = agents(AGENTS, MESSAGES, { live: Math.min(8, AGENTS) })
const sessions = specs.map(sessionInfo)
const root = rootSession()

const build = (index: number): SessionMessageInfo[] => {
  const spec = specs[index]!
  const out: SessionMessageInfo[] = [
    { id: `${spec.id}_u0`, type: "user", time: { created: spec.created }, text: "do the task" } as unknown as SessionMessageInfo,
  ]
  for (let m = 1; m <= spec.messages; m += 1) {
    out.push(message(spec.id, m, spec.created + m * 1_000, spec.toolsPerMessage, spec.live && m >= spec.messages - 2))
  }
  return out
}

const initial: Record<string, readonly SessionMessageInfo[]> = { ses_root: [message("ses_root", 1, root.time.created + 500, 1, false)] }
specs.forEach((spec, index) => (initial[spec.id] = build(index)))
// Two store shapes. `record` replaces the whole message record on every delta
// (the fa0 measured baseline); `session` keeps one signal per session, which is
// what the host's per-session store array does, so one delta invalidates one
// branch. Both are the same modules and the same frames.
const MODE = process.env.STORE ?? "record"
const [store, setStore] = createSignal<Readonly<Record<string, readonly SessionMessageInfo[]>>>(initial)
const perSession = new Map<string, [Accessor<readonly SessionMessageInfo[]>, Setter<readonly SessionMessageInfo[]>]>(
  Object.entries(initial).map(([id, list]) => [id, createSignal<readonly SessionMessageInfo[]>(list)]),
)

const base = context({ sessions: [root, ...sessions], animations: true })
const value = {
  ...base,
  data: {
    ...base.data,
    session: {
      ...base.data.session,
      status: (id: string) => (specs.some((spec) => spec.id === id && spec.live) ? "running" : "idle"),
      message: {
        ...base.data.session.message,
        list: (id: string) => {
          count.listCalls += 1
          return MODE === "session" ? (perSession.get(id)?.[0]() ?? []) : (store()[id] ?? [])
        },
        get: (id: string, messageID: string) =>
          (MODE === "session"
            ? (perSession.get(id)?.[0]() ?? [])
            : (store()[id] ?? [])
          ).find((item) => item.id === messageID),
      },
      permission: { ...base.data.session.permission, list: () => [] },
      form: { ...base.data.session.form, list: () => [] },
    },
  },
} as any

const meshRoot: MeshNode = meshNode({
  sessionID: "ses_root",
  agent: "build",
  state: "running",
  createdAt: root.time.created,
  children: specs.map((spec) =>
    meshNode({
      sessionID: spec.id,
      agent: spec.agent,
      state: spec.live ? "running" : "idle",
      createdAt: spec.created,
      children: [],
    }),
  ),
})
const mesh = meshLive({ root: meshRoot, maxSubagents: 12, swarmMode: true })

// The app's own 12 fps clock, driven by hand so a frame is one tick.
let clockMs = root.time.created + MESSAGES * 1_000 + 10_000
let interval: (() => void) | undefined
const ticker = createTicker({
  animations: () => true,
  now: () => clockMs,
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
      mesh={mesh}
      ticker={ticker}
      now={() => clockMs}
      width={COLS}
    />
  ),
  { width: COLS, height: ROWS, nativeSceneVerify: false },
)
await app.renderOnce()

// --- helpers -------------------------------------------------------------------
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}
const stats = () => app.getNativeStats()
const frame = async (label: string, advance: boolean, mutate?: () => void) => {
  reset()
  const gridBefore = { uploads: CELL_GRID_STATS.uploads, paints: CELL_GRID_STATS.paints }
  const start = performance.now()
  let advanceMs = 0
  if (advance) {
    const advanceStart = performance.now()
    clockMs += 1000 / 12
    interval?.()
    advanceMs = performance.now() - advanceStart
  }
  const effectStart = performance.now()
  mutate?.()
  const effectMs = performance.now() - effectStart
  await app.renderOnce()
  const ms = performance.now() - start
  const after = stats()
  return {
    label,
    ms,
    effectMs: advanceMs + effectMs,
    paintMs: ms - advanceMs - effectMs,
    cellsUpdated: after.cellsUpdated,
    nativeRenderTime: after.nativeRenderTime ?? 0,
    damageRows: (after.frameWork as any)?.damageRows ?? 0,
    uploads: CELL_GRID_STATS.uploads - gridBefore.uploads,
    gridPaints: CELL_GRID_STATS.paints - gridBefore.paints,
    ...count,
  }
}

type Sample = Awaited<ReturnType<typeof frame>>
const report = (label: string, samples: Sample[]) => {
  const ms = samples.map((sample) => sample.ms)
  const cells = samples.map((sample) => sample.cellsUpdated)
  const sum = (pick: (sample: Sample) => number) => samples.reduce((total, sample) => total + pick(sample), 0)
  const perFrame = (pick: (sample: Sample) => number) => +(sum(pick) / Math.max(1, samples.length)).toFixed(2)
  console.log(
    JSON.stringify({
      label,
      n: samples.length,
      msMedian: +median(ms).toFixed(3),
      msP95: +[...ms].sort((a, b) => a - b)[Math.floor(ms.length * 0.95)]!.toFixed(3),
      effectMsMedian: +median(samples.map((sample) => sample.effectMs)).toFixed(3),
      paintMsMedian: +median(samples.map((sample) => sample.paintMs)).toFixed(3),
      msTotal: +ms.reduce((a, b) => a + b, 0).toFixed(1),
      cellsUpdatedMedian: median(cells),
      commitCalls: sum((s) => s.commit),
      commitChanged: sum((s) => s.commitChanged),
      renderSelf: perFrame((s) => s.renderSelf),
      gridClears: sum((s) => s.gridClear),
      gridSetCell: perFrame((s) => s.gridSetCell),
      gridText: sum((s) => s.gridText),
      ffiSetCell: perFrame((s) => s.ffiSetCell),
      ffiFrame: perFrame((s) => s.ffiFrame),
      upload: perFrame((s) => s.uploads),
      gridPaints: perFrame((s) => s.gridPaints),
      renderSelfNsPerCell: Math.round((sum((s) => s.selfMs) * 1_000_000) / Math.max(1, sum((s) => s.selfCells))),
      renderSelfCells: sum((s) => s.selfCells),
      commitMs: +sum((s) => s.commitMs).toFixed(1),
      listCalls: sum((s) => s.listCalls),
      damageRowsMedian: median(samples.map((sample) => sample.damageRows)),
      nativeRenderMsLast: +samples.at(-1)!.nativeRenderTime.toFixed(2),
    }),
  )
}

// --- phases --------------------------------------------------------------------
const mark = (name: string) => console.log(JSON.stringify({ mark: name, epochMs: Date.now() }))
for (let i = 0; i < 20; i += 1) await frame("warmup", true)

const ticks: Sample[] = []
mark("tick-start")
for (let i = 0; i < FRAMES; i += 1) ticks.push(await frame("tick", true))
mark("tick-end")
report("tick", ticks)

// A streamed text delta: one new message on the session that is currently writing.
mark("delta-start")
const deltas: Sample[] = []
for (let i = 0; i < FRAMES; i += 1) {
  const index = i % AGENTS
  const spec = specs[index]!
  const next = message(spec.id, MESSAGES + 1 + i, clockMs, 1, spec.live)
  deltas.push(
    await frame("delta", false, () => {
      if (MODE === "session") {
        const signal = perSession.get(spec.id)!
        signal[1]([...signal[0](), next])
        return
      }
      const current = store()
      setStore({ ...current, [spec.id]: [...(current[spec.id] ?? []), next] })
    }),
  )
}
report("delta", deltas)
mark("delta-end")

// A passive tick with no data change at all.
const idle: Sample[] = []
for (let i = 0; i < 20; i += 1) idle.push(await frame("idle", false))
report("idle", idle)

// The other lenses, same data and clock.
const { lensStore } = await import("../src/components/understory/view")
const lens = lensStore(value)
lens.set("stream")
for (let i = 0; i < 10; i += 1) await frame("stream-warm", true)
const streamFrames: Sample[] = []
for (let i = 0; i < 30; i += 1) streamFrames.push(await frame("stream", true))
report("lens-stream", streamFrames)

lens.set("roots")
for (let i = 0; i < 10; i += 1) await frame("roots-warm", true)
const rootsFrames: Sample[] = []
for (let i = 0; i < 30; i += 1) rootsFrames.push(await frame("roots", true))
report("lens-roots", rootsFrames)
lens.set("trace")

await app.dispose?.()
