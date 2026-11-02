/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA, type KeyEvent } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { Show, createSignal } from "solid-js"
import { BanyanHero } from "../src/components/home/hero"
import { GROWTH_END, createGrowth, type Growth } from "../src/components/home/growth"
import { TREE_ROWS_AT_6, WORDMARK_ROWS_AT_6 } from "./fixture/home-keyframes"
import { context, theme } from "./harness"

const growthTheme = () =>
  ({
    ...theme,
    growth: {
      leaf: RGBA.fromInts(127, 214, 138),
      highlight: RGBA.fromInts(200, 242, 124),
      done: RGBA.fromInts(37, 80, 47),
      faded: RGBA.fromInts(75, 138, 88),
      wood: RGBA.fromInts(169, 130, 87),
      bright: RGBA.fromInts(246, 250, 242),
    },
  }) as unknown as Context["theme"]

type Handle = ReturnType<typeof setInterval>

/** A growth clock the test drives, backed by the real `createGrowth`. */
function manualGrowth() {
  let time = 0
  let tick: (() => void) | undefined
  return {
    growth: createGrowth({
      animations: () => true,
      now: () => time,
      setInterval: ((fn: () => void) => {
        tick = fn
        return 1 as unknown as Handle
      }) as typeof setInterval,
      clearInterval: (() => {
        tick = undefined
      }) as typeof clearInterval,
    }),
    advance(ms: number) {
      time += ms
      tick?.()
    },
    get pending() {
      return tick !== undefined
    },
  }
}

async function mountHero(options: {
  width: number
  height: number
  growth: Growth
  headerRows?: number
  centered?: boolean
  marker?: boolean
}) {
  const setup = await createTestRenderer({ width: options.width, height: options.height, kittyKeyboard: true })
  const host = { ...context(), renderer: setup.renderer, theme: growthTheme() } as Context
  await render(
    () => (
      <box flexDirection="column" width="100%" height="100%" alignItems={options.centered ? "center" : undefined}>
        <Show when={options.headerRows}>
          <box height={options.headerRows} flexShrink={0} />
        </Show>
        <BanyanHero context={host} growth={options.growth} />
        <Show when={options.marker}>
          <text fg={theme.text.base}>marker</text>
        </Show>
      </box>
    ),
    setup.renderer,
  )
  await setup.renderOnce()
  return { setup, host }
}

const rowsOf = (setup: TestRendererSetup) =>
  setup.captureCharFrame().split("\n").map((row) => row.padEnd(setup.renderer.width, " "))

const cellsOf = (setup: TestRendererSetup) =>
  setup
    .captureSpans()
    .lines.map((line) =>
      line.spans.map((span) => `${span.text}|${span.fg.toString()}|${span.bg.toString()}|${span.attributes}`).join(","),
    )
    .join("\n")

const finished = () => createGrowth({ animations: () => false })

const TIERS: ReadonlyArray<readonly [number, number, "full" | "compact" | "plain" | "none"]> = [
  [200, 55, "full"],
  [120, 40, "full"],
  [119, 40, "compact"],
  [120, 39, "compact"],
  [72, 18, "compact"],
  [71, 18, "plain"],
  [60, 12, "plain"],
  [60, 11, "none"],
]

describe("BanyanHero layout", () => {
  for (const [width, height, tier] of TIERS) {
    test(`draws the ${tier} hero at ${width}x${height}`, async () => {
      const { setup } = await mountHero({ width, height, growth: finished(), centered: true })
      try {
        const frame = setup.captureCharFrame()
        const tree = /[\u2800-\u28ff]/.test(frame)
        const blocks = frame.includes("█")
        expect(tree).toBe(tier === "full")
        expect(blocks).toBe(tier === "full" || tier === "compact")
        expect(frame.includes("─")).toBe(tier === "full")
        expect(frame.includes("BanyanCode")).toBe(tier === "plain")
        if (tier === "none") expect(frame.trim()).toBe("")
      } finally {
        await setup.dispose()
      }
    })
  }

  test("mounts with the plain harness context, which has no key input", async () => {
    const setup = await createTestRenderer({ width: 200, height: 55, kittyKeyboard: true })
    try {
      await render(() => <BanyanHero context={context()} growth={finished()} />, setup.renderer)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toMatch(/[\u2800-\u28ff]/)
    } finally {
      await setup.dispose()
    }
  })

  test("keeps its size from the first frame to the last", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({
      width: 168,
      height: 48,
      growth: clock.growth,
      headerRows: 1,
      centered: true,
      marker: true,
    })
    try {
      const markerRow = () => rowsOf(setup).findIndex((row) => row.includes("marker"))
      const start = markerRow()
      expect(start).toBeGreaterThan(0)
      clock.advance(3000)
      await setup.renderOnce()
      expect(markerRow()).toBe(start)
      clock.advance(4000)
      await setup.renderOnce()
      expect(markerRow()).toBe(start)
    } finally {
      await setup.dispose()
    }
  })

  test("draws the mockup's tree, rule and wordmark at their exact position", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    try {
      clock.advance(6000)
      await setup.renderOnce()
      const rows = rowsOf(setup)
      TREE_ROWS_AT_6.forEach((expected, index) => {
        expect(rows[14 + index]!.slice(34, 134).trimEnd()).toBe(expected)
      })
      expect(rows[24]!.slice(34, 134)).toBe("          " + "─".repeat(80) + "          ")
      WORDMARK_ROWS_AT_6.forEach((expected, index) => {
        expect(rows[26 + index]!.slice(55, 114).trimEnd()).toBe(expected)
      })
    } finally {
      await setup.dispose()
    }
  })

  test("grows the ground rule out to its full width", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    try {
      const width = () => rowsOf(setup)[24]!.split("").filter((char) => char === "─").length
      expect(width()).toBe(0)
      clock.advance(600)
      await setup.renderOnce()
      expect(width()).toBe(50)
      clock.advance(1600)
      await setup.renderOnce()
      expect(width()).toBe(80)
    } finally {
      await setup.dispose()
    }
  })
})

describe("BanyanHero growth", () => {
  test("a keypress jumps to the finished tree without eating the input", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    try {
      clock.advance(1000)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(false)
      const partial = setup.captureCharFrame()
      expect(partial.includes("█")).toBe(false)

      const seen: KeyEvent[] = []
      setup.renderer.keyInput.on("keypress", (key: KeyEvent) => seen.push(key))
      setup.mockInput.pressKey("a")
      await setup.renderOnce()

      expect(clock.growth.done()).toBe(true)
      expect(clock.growth.elapsed()).toBe(GROWTH_END)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.defaultPrevented).toBe(false)
      expect(setup.captureCharFrame()).toContain("█")
    } finally {
      await setup.dispose()
    }
  })

  test("a paste jumps to the finished tree", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    try {
      clock.advance(500)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(false)
      await setup.mockInput.pasteBracketedText("hello")
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(true)
      expect(clock.growth.elapsed()).toBe(GROWTH_END)
    } finally {
      await setup.dispose()
    }
  })

  test("never asks for live frames and stops once finished", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    try {
      clock.advance(1000)
      await setup.renderOnce()
      expect(setup.renderer.root.liveCount).toBe(0)
      clock.growth.finish()
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(true)
      expect(clock.pending).toBe(false)
      expect(setup.renderer.getSchedulerState().hasScheduledRender).toBe(false)
    } finally {
      await setup.dispose()
    }
  })

  test("the final frame is identical cell for cell on every render", async () => {
    const { setup } = await mountHero({ width: 168, height: 48, growth: finished(), headerRows: 1, centered: true })
    try {
      const first = rowsOf(setup).join("\n")
      const firstCells = cellsOf(setup)
      await setup.renderOnce()
      expect(rowsOf(setup).join("\n")).toBe(first)
      expect(cellsOf(setup)).toBe(firstCells)
      expect(first).toContain("█")
      expect(first).toMatch(/[\u2800-\u28ff]/)
    } finally {
      await setup.dispose()
    }
  })

  test("repaints when the theme changes", async () => {
    const setup = await createTestRenderer({ width: 100, height: 29, kittyKeyboard: true })
    const [bright, setBright] = createSignal(RGBA.fromInts(246, 250, 242))
    const themed = () => {
      const value = growthTheme() as unknown as { growth: Record<string, RGBA> }
      return { ...value, growth: { ...value.growth, bright: bright() } } as unknown as Context["theme"]
    }
    const host = { ...context(), renderer: setup.renderer, get theme() { return themed() } } as Context
    try {
      await render(() => <BanyanHero context={host} growth={finished()} />, setup.renderer)
      await setup.renderOnce()
      const before = cellsOf(setup)
      setBright(RGBA.fromInts(255, 64, 32))
      await setup.renderOnce()
      expect(cellsOf(setup)).not.toBe(before)
    } finally {
      await setup.dispose()
    }
  })

  test("cleaning up mid-growth finishes the tree and leaves no timer", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    clock.advance(500)
    expect(clock.pending).toBe(true)
    await setup.dispose()
    expect(clock.pending).toBe(false)
    expect(clock.growth.done()).toBe(true)
  })

  test("switching tiers mid-growth keeps animating without crashing", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 200, height: 55, growth: clock.growth, centered: true })
    try {
      clock.advance(1000)
      await setup.renderOnce()
      expect(/[\u2800-\u28ff]/.test(setup.captureCharFrame())).toBe(true)
      setup.resize(60, 12)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("BanyanCode")
      clock.advance(500)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(false)
      expect(clock.pending).toBe(true)
    } finally {
      await setup.dispose()
    }
  })
})
