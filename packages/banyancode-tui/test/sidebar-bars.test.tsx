/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { PerformancePanel } from "../src/components/sidebar/performance"
import { ProviderUsagePanel } from "../src/components/sidebar/provider-usage"
import { SystemPanel } from "../src/components/sidebar/system-status"
import { asciiBar } from "../src/data/usage"
import type { ProviderUsageSnapshot } from "../src/data/pending-rpc"
import { context, mount, session, systemLive, usageLive } from "./harness"

const BLOCKS = new Set(["█", "░"])

type App = Awaited<ReturnType<typeof mount>>

function lines(app: App) {
  return app.captureCharFrame().split("\n")
}

function lineOf(app: App, label: string) {
  const line = lines(app).find((item) => item.trimStart().startsWith(label))
  if (line === undefined) throw new Error(`no sidebar row starts with ${label}`)
  return line
}

/** Start/end column and fill of the `█/░` run in a row. */
function barCells(line: string) {
  const cells = [...line]
  const indices = cells.flatMap((cell, index) => (BLOCKS.has(cell) ? [index] : []))
  return {
    start: indices[0],
    end: indices[indices.length - 1],
    columns: indices.length,
    filled: indices.filter((index) => cells[index] === "█").length,
  }
}

function barOf(app: App, label: string) {
  const bar = barCells(lineOf(app, label))
  if (bar.start === undefined || bar.end === undefined) throw new Error(`no bar on the ${label} row`)
  return { start: bar.start, end: bar.end, columns: bar.columns, filled: bar.filled }
}

/** One past the last non-blank column: the row's right edge. */
function rightEdge(line: string) {
  return line.trimEnd().length
}

// --- fixtures ---------------------------------------------------------------

const SYSTEM_STATUS = {
  cpuPercent: 12,
  memoryUsedBytes: 4 * 1024 ** 3,
  memoryTotalBytes: 16 * 1024 ** 3,
  diskUsedBytes: 100 * 1024 ** 3,
  diskTotalBytes: 500 * 1024 ** 3,
  platform: "windows" as const,
}

// The harness theme paints `surfaceHigh` with the same RGBA as everything else,
// so the system meter rows are the only rows whose background is not blank.
const SURFACE = "200,200,200"

function meterEnds(app: App) {
  return app.captureSpans().lines.map((line) => {
    let end = -1
    let column = 0
    for (const span of line.spans) {
      const [red, green, blue] = span.bg.toInts()
      if (`${red},${green},${blue}` === SURFACE) end = column + span.width - 1
      column += span.width
    }
    return end
  })
}

/** A completed 10s step: tokens/s is `output / 10`. */
function stepMessage(output: number): SessionMessageInfo {
  return {
    id: "msg_step",
    type: "assistant",
    agent: "build",
    model: { providerID: "provider", id: "model" },
    time: { created: 0, completed: 10_000 },
    tokens: { input: 1_000, output, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [],
  } as unknown as SessionMessageInfo
}

function performanceApp(width: number, output: number) {
  const root = session({ id: `ses_perf_${output}`, title: "performance" })
  const ctx = context({ sessions: [root], messages: { [root.id]: [stepMessage(output)] } })
  return mount(
    () => (
      <box width={width}>
        <PerformancePanel context={ctx} sessionID={root.id} />
      </box>
    ),
    { width, height: 12 },
  )
}

function systemApp(width: number) {
  return mount(
    () => (
      <box width={width}>
        <SystemPanel context={context()} system={systemLive({ status: SYSTEM_STATUS })} />
      </box>
    ),
    { width, height: 12 },
  )
}

function usageSnapshot(percents: readonly number[]): ProviderUsageSnapshot {
  const now = Date.now()
  const labels = ["5h", "7d", "30d"]
  const countdowns = [2 * 3_600_000 + 35 * 60_000, (15 * 24 + 22) * 3_600_000, 30 * 24 * 3_600_000]
  return {
    providerID: "anthropic",
    displayName: "Anthropic",
    status: "available",
    confidence: "exact",
    windows: percents.map((percent, index) => ({
      id: `window_${index}`,
      label: labels[index]!,
      kind: "rate_limit" as const,
      remainingPercent: percent,
      // Half a minute of slack so the minute-truncated countdown is stable.
      resetsAt: now + (countdowns[index] ?? countdowns[0]!) + 30_000,
    })),
    fetchedAt: now,
  }
}

function usageApp(width: number, percents: readonly number[] = [62, 53]) {
  const root = session({
    id: "ses_usage",
    title: "usage",
    model: { providerID: "anthropic" as never, id: "claude" },
  })
  const ctx = context({ sessions: [root] })
  const usage = usageLive({ providers: [usageSnapshot(percents)] })
  return mount(
    () => (
      <box width={width}>
        <ProviderUsagePanel context={ctx} sessionID="ses_usage" usage={usage} />
      </box>
    ),
    { width, height: 12 },
  )
}

function barsIn(app: App) {
  return lines(app).map((line) => barCells(line)).filter((bar) => bar.columns > 0)
}

async function close(...apps: App[]) {
  for (const app of apps) app.renderer.destroy()
}

// --- right edge -------------------------------------------------------------

test("performance and usage bars end on the same right edge as the system meters", async () => {
  for (const width of [30, 48]) {
    const performance = await performanceApp(width, 714)
    const usage = await usageApp(width)
    const system = await systemApp(width)
    try {
      await performance.renderOnce()
      await usage.renderOnce()
      await system.renderOnce()

      const meters = meterEnds(system).filter((end) => end !== -1)
      expect(meters.length).toBeGreaterThanOrEqual(3)
      // Every system meter ends on the panel's last column.
      expect(meters.every((end) => end === width - 1)).toBe(true)

      expect(rightEdge(lineOf(performance, "Tokens/s"))).toBe(width)
      expect(rightEdge(lineOf(performance, "Output"))).toBe(width)
      expect(rightEdge(lineOf(usage, "5h"))).toBe(width)
      expect(rightEdge(lineOf(usage, "7d"))).toBe(width)
      // The bar consumes the space between the label and the value, so it owns
      // most of the row rather than sitting at its v1 8/9 columns.
      expect(barOf(performance, "Tokens/s").columns).toBeGreaterThan(width / 2)
      expect(barOf(usage, "7d").columns).toBeGreaterThan(width / 2)
    } finally {
      await close(performance, usage, system)
    }
  }
})

// --- shared columns ---------------------------------------------------------

test("bars in a group share their start and end columns across value lengths", async () => {
  const performance = await performanceApp(40, 714)
  const usage = await usageApp(40)
  try {
    await performance.renderOnce()
    await usage.renderOnce()

    // "71.4" and "714" are different lengths; the bars still line up.
    expect(lineOf(performance, "Tokens/s")).toContain("71.4")
    expect(lineOf(performance, "Output")).toContain("714")
    const tokens = barOf(performance, "Tokens/s")
    const output = barOf(performance, "Output")
    expect(tokens.start).toBe(output.start)
    expect(tokens.end).toBe(output.end)
    expect(tokens.columns).toBeGreaterThan(3)

    // "62% 2h35m" and "53% 15d22h" are different lengths too.
    const fiveHours = barOf(usage, "5h")
    const sevenDays = barOf(usage, "7d")
    expect(fiveHours.start).toBe(sevenDays.start)
    expect(fiveHours.end).toBe(sevenDays.end)
    expect(fiveHours.columns).toBeGreaterThan(3)
  } finally {
    await close(performance, usage)
  }
})

// --- proportions ------------------------------------------------------------

test("usage bars keep their proportion at 0, 50 and 100 percent", async () => {
  expect(asciiBar(0, 10)).toBe("░".repeat(10))
  expect(asciiBar(50, 10)).toBe("█".repeat(5) + "░".repeat(5))
  expect(asciiBar(100, 10)).toBe("█".repeat(10))

  const usage = await usageApp(40, [0, 50, 100])
  try {
    await usage.renderOnce()
    const bars = barsIn(usage)
    expect(bars).toHaveLength(3)
    const columns = bars[0]!.columns
    expect(bars.every((bar) => bar.columns === columns)).toBe(true)
    expect(bars[0]!.filled).toBe(0)
    expect(bars[1]!.filled).toBe(Math.round(columns / 2))
    expect(bars[2]!.filled).toBe(columns)
  } finally {
    await close(usage)
  }
})

test("performance bars keep their 8-unit proportion", async () => {
  const half = await performanceApp(40, 400)
  const full = await performanceApp(40, 800)
  const none = await performanceApp(40, 0)
  try {
    await half.renderOnce()
    await full.renderOnce()
    await none.renderOnce()

    const mid = barOf(half, "Tokens/s")
    expect(mid.filled).toBe(Math.round(mid.columns / 2))

    const all = barOf(full, "Tokens/s")
    expect(all.columns).toBe(mid.columns)
    expect(all.filled).toBe(all.columns)

    // v1 kept one filled column at zero; the stretched bar keeps that cue.
    const zero = barOf(none, "Tokens/s")
    expect(zero.filled).toBe(Math.max(1, Math.round(zero.columns / 8)))
  } finally {
    await close(half, full, none)
  }
})

// --- resize -----------------------------------------------------------------

test("bars re-stretch when the sidebar resizes", async () => {
  const root = session({ id: "ses_resize", title: "resize" })
  const ctx = context({ sessions: [root], messages: { [root.id]: [stepMessage(714)] } })
  const app = await mount(
    () => (
      <box width="100%">
        <PerformancePanel context={ctx} sessionID={root.id} />
      </box>
    ),
    { width: 30, height: 8 },
  )
  try {
    await app.renderOnce()
    const before = barOf(app, "Tokens/s")
    app.renderer.resize(48, 8)
    await app.renderOnce()
    await app.renderOnce()
    const after = barOf(app, "Tokens/s")
    expect(after.columns).toBeGreaterThan(before.columns)
    expect(rightEdge(lineOf(app, "Tokens/s"))).toBe(48)
  } finally {
    await close(app)
  }
})

// --- narrowest width --------------------------------------------------------

test("bars and values stay inside the narrowest sidebar width", async () => {
  for (const width of [18, 20]) {
    const performance = await performanceApp(width, 714)
    const usage = await usageApp(width)
    try {
      await performance.renderOnce()
      await usage.renderOnce()

      for (const line of lines(performance)) expect([...line].length).toBeLessThanOrEqual(width)
      for (const line of lines(usage)) expect([...line].length).toBeLessThanOrEqual(width)

      expect(lineOf(performance, "Tokens/s")).toContain("71.4")
      expect(barOf(performance, "Tokens/s").columns).toBeGreaterThan(0)
      expect(lineOf(usage, "7d")).toContain("15d22h")
      expect(barOf(usage, "7d").columns).toBeGreaterThan(0)
    } finally {
      await close(performance, usage)
    }
  }
})
