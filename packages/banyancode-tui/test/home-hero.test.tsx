/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA, type KeyEvent } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { Show, createSignal } from "solid-js"
import { BanyanHero, heroRows } from "../src/components/home/hero"
import {
  AMBIENT_TICK_MS,
  GROWTH_END,
  GROWTH_TICK_MS,
  createGrowth,
  type Growth,
} from "../src/components/home/growth"
import { TREE_ROWS_SHORT } from "../src/components/home/banyan-tree"
import { FINAL_TREE_23, FINAL_TREE_27, WORDMARK_ROWS_AT_6 } from "./fixture/home-keyframes"
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
  let scheduled = 0
  const delays: number[] = []
  return {
    growth: createGrowth({
      animations: () => true,
      now: () => time,
      setInterval: ((fn: () => void, delay: number) => {
        scheduled += 1
        delays.push(delay)
        tick = fn
        return scheduled as unknown as Handle
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
    get scheduled() {
      return scheduled
    },
    get delays() {
      return delays
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
  homeHeight?: () => number
}) {
  const setup = await createTestRenderer({ width: options.width, height: options.height, kittyKeyboard: true })
  const host = { ...context(), renderer: setup.renderer, theme: growthTheme() } as Context
  await render(
    () => (
      <box flexDirection="column" width="100%" height="100%" alignItems={options.centered ? "center" : undefined}>
        <Show when={options.headerRows}>
          <box height={options.headerRows} flexShrink={0} />
        </Show>
        <BanyanHero context={host} growth={options.growth} height={options.homeHeight} />
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

/** Every cell of the frame, line by line, as text plus colour. */
const lineCells = (setup: TestRendererSetup) =>
  setup
    .captureSpans()
    .lines.map((line) =>
      line.spans.map((span) => `${span.text}|${span.fg.toString()}|${span.bg.toString()}|${span.attributes}`).join(","),
    )

const cellsOf = (setup: TestRendererSetup) => lineCells(setup).join("\n")

/** The rows a finished full hero keeps perfectly still: everything but the canopy. */
const stillLines = (setup: TestRendererSetup) =>
  lineCells(setup)
    .filter((_, row) => row === 0 || row > TREE_ROWS_SHORT)
    .join("\n")

const cellsUpdated = (setup: TestRendererSetup) => setup.getNativeStats().cellsUpdated

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

describe("heroRows", () => {
  test("is the one source of truth for the hero's size", () => {
    // The terminal decides the tier, as the mockup's thresholds say.
    expect(heroRows(120, 40, 40)).toBe(29)
    expect(heroRows(120, 45, 45)).toBe(29)
    expect(heroRows(119, 40, 40)).toBe(4)
    expect(heroRows(120, 39, 39)).toBe(4)
    expect(heroRows(72, 18, 18)).toBe(4)
    expect(heroRows(71, 18, 18)).toBe(1)
    expect(heroRows(60, 11, 11)).toBe(0)

    // Chrome never demotes the tree while the tree, prompt and footer still fit.
    expect(heroRows(120, 40, 39)).toBe(29)
    expect(heroRows(120, 40, 38)).toBe(29)
    expect(heroRows(120, 40, 36)).toBe(29)
    expect(heroRows(120, 40, 35)).toBe(4)

    // The tall tier also has to leave room for the list under it.
    expect(heroRows(120, 46, 46)).toBe(33)
    expect(heroRows(120, 46, 45)).toBe(29)
    expect(heroRows(120, 47, 46)).toBe(33)
    expect(heroRows(200, 60, 60)).toBe(33)

    // 120x40 stays exactly in budget: hero 29 + prompt 6 + resume 4 + footer 1.
    expect(heroRows(120, 40, 40) + 6 + 4 + 1).toBe(40)
    // 46 rows fit the tall hero, two gaps, the prompt, the list and the footer.
    expect(heroRows(120, 46, 46) + 2 + 6 + 4 + 1).toBe(46)
  })
})

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

  test("draws the checked-in final frame, rule and wordmark at 23 tree rows", async () => {
    const { setup } = await mountHero({ width: 120, height: 40, growth: finished(), headerRows: 1, centered: true })
    try {
      const rows = rowsOf(setup)
      FINAL_TREE_23.forEach((expected, index) => {
        expect(rows[1 + index]!.slice(10, 110)).toBe(expected)
      })
      expect(rows[24]!.slice(10, 110)).toBe("          " + "─".repeat(80) + "          ")
      WORDMARK_ROWS_AT_6.forEach((expected, index) => {
        expect(rows[26 + index]!.slice(31, 90).trimEnd()).toBe(expected)
      })
    } finally {
      await setup.dispose()
    }
  })

  test("grows a four-row-taller tree when the terminal is tall", async () => {
    const { setup } = await mountHero({ width: 168, height: 48, growth: finished(), headerRows: 1, centered: true })
    try {
      const rows = rowsOf(setup)
      FINAL_TREE_27.forEach((expected, index) => {
        expect(rows[1 + index]!.slice(34, 134)).toBe(expected)
      })
      expect(rows[28]!.slice(34, 134)).toBe("          " + "─".repeat(80) + "          ")
      WORDMARK_ROWS_AT_6.forEach((expected, index) => {
        expect(rows[30 + index]!.slice(55, 114).trimEnd()).toBe(expected)
      })
    } finally {
      await setup.dispose()
    }
  })

  test("grows the ground rule out to its full width", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1 })
    try {
      const width = () => rowsOf(setup)[28]!.split("").filter((char) => char === "─").length
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

  test("picks its tier from the terminal, and only denies the full hero when it cannot fit", async () => {
    // Rule row minus the first braille row is the tree height; 0 means the compact tier.
    const artRows = (rows: readonly string[]) => {
      const rule = rows.findIndex((row) => row.includes("─"))
      if (rule < 0) return 0
      const first = rows.findIndex((row) => /[\u2800-\u28ff]/.test(row))
      return first < 0 ? 0 : rule - first
    }
    for (const [terminal, home, tree] of [
      [40, 40, 23],
      // Chrome costs rows, but the tree is not the thing that gives way.
      [40, 39, 23],
      [40, 38, 23],
      [40, 36, 23],
      // Below 36 Home cannot hold tree, prompt and footer: the wordmark steps in.
      [40, 35, 0],
      // The tall tier needs room for the list too.
      [46, 45, 23],
      [46, 46, 27],
    ] as const) {
      const { setup } = await mountHero({ width: 120, height: terminal, growth: finished(), homeHeight: () => home })
      try {
        const rows = rowsOf(setup)
        expect({ terminal, home, tree: artRows(rows) }).toEqual({ terminal, home, tree })
        if (tree === 0) expect(rows.join("\n")).toContain("█")
      } finally {
        await setup.dispose()
      }
    }
  })
})

describe("BanyanHero loop", () => {
  test("a keypress skips growth but the sparkle keeps going, and the input is not eaten", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    try {
      clock.advance(1000)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(false)
      expect(setup.captureCharFrame().includes("█")).toBe(false)

      const seen: KeyEvent[] = []
      setup.renderer.keyInput.on("keypress", (key: KeyEvent) => seen.push(key))
      setup.mockInput.pressKey("a")
      await setup.renderOnce()

      expect(clock.growth.done()).toBe(true)
      expect(clock.growth.elapsed()).toBe(GROWTH_END)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.defaultPrevented).toBe(false)
      expect(clock.pending).toBe(true)
      const structure = rowsOf(setup).join("\n")
      const before = cellsOf(setup)
      clock.advance(AMBIENT_TICK_MS)
      await setup.renderOnce()
      expect(rowsOf(setup).join("\n")).toBe(structure)
      expect(cellsOf(setup)).not.toBe(before)
    } finally {
      await setup.dispose()
    }
  })

  test("a paste skips growth", async () => {
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
      expect(clock.pending).toBe(true)
    } finally {
      await setup.dispose()
    }
  })

  test("the finished tree keeps sparkling while its structure, rule and wordmark stay put", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 120, height: 40, growth: clock.growth, headerRows: 1 })
    try {
      clock.advance(7000)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(true)
      // The clock is still running after growth: that is the ambient sparkle.
      expect(clock.pending).toBe(true)
      const structure = rowsOf(setup).join("\n")
      const still = stillLines(setup)
      let previous = cellsOf(setup)
      for (let frame = 0; frame < 6; frame += 1) {
        clock.advance(AMBIENT_TICK_MS)
        await setup.renderOnce()
        // Chars never move: the tree, the ground rule and the wordmark are a still.
        expect(rowsOf(setup).join("\n")).toBe(structure)
        // Colours outside the canopy never move either.
        expect(stillLines(setup)).toBe(still)
        // Inside the canopy the dots that twinkle do.
        const current = cellsOf(setup)
        expect(current).not.toBe(previous)
        previous = current
      }
      expect(clock.growth.elapsed()).toBe(GROWTH_END)
    } finally {
      await setup.dispose()
    }
  })

  test("an ambient frame repaints only the dots that twinkle", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 120, height: 40, growth: clock.growth, headerRows: 1 })
    try {
      clock.advance(7000)
      await setup.renderOnce()
      const seen: number[] = []
      for (let frame = 0; frame < 20; frame += 1) {
        clock.advance(AMBIENT_TICK_MS)
        await setup.renderOnce()
        seen.push(cellsUpdated(setup))
      }
      // The sparkle changes dots; a redraw of the tree would move hundreds of cells.
      expect(Math.min(...seen)).toBeGreaterThan(0)
      expect(Math.max(...seen)).toBeLessThanOrEqual(100)
    } finally {
      await setup.dispose()
    }
  })

  test("keeps shimmering the wordmark in the compact tier, growing and finished", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 80, height: 20, growth: clock.growth })
    try {
      clock.advance(1000)
      await setup.renderOnce()
      const before = cellsOf(setup)
      clock.advance(500)
      await setup.renderOnce()
      expect(cellsOf(setup)).not.toBe(before)

      // The wordmark is the compact tier's whole picture, so it keeps sweeping.
      clock.advance(7000)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(true)
      expect(clock.pending).toBe(true)
      const finished = cellsOf(setup)
      clock.advance(AMBIENT_TICK_MS)
      await setup.renderOnce()
      expect(cellsOf(setup)).not.toBe(finished)
    } finally {
      await setup.dispose()
    }
  })

  test("pauses on cleanup and never asks for live frames", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 168, height: 48, growth: clock.growth, headerRows: 1, centered: true })
    clock.advance(7000)
    await setup.renderOnce()
    expect(clock.growth.done()).toBe(true)
    expect(clock.growth.ambient()).toBeGreaterThan(0)
    expect(setup.renderer.root.liveCount).toBe(0)
    expect(clock.pending).toBe(true)
    const ambient = clock.growth.ambient()
    await setup.dispose()
    // Unmounting stops the sparkle: the session view costs nothing.
    expect(clock.pending).toBe(false)
    expect(clock.growth.done()).toBe(true)
    expect(clock.growth.ambient()).toBe(ambient)
  })

  test("mounting Home again resumes the sparkle where it stopped, without replaying growth", async () => {
    const clock = manualGrowth()
    const first = await mountHero({ width: 120, height: 40, growth: clock.growth, headerRows: 1 })
    clock.advance(7000)
    await first.setup.renderOnce()
    expect(clock.pending).toBe(true)
    await first.setup.dispose()
    expect(clock.pending).toBe(false)
    const resumedAt = clock.growth.ambient()

    const second = await mountHero({ width: 120, height: 40, growth: clock.growth, headerRows: 1 })
    try {
      expect(clock.pending).toBe(true)
      expect(clock.growth.elapsed()).toBe(GROWTH_END)
      expect(clock.growth.ambient()).toBe(resumedAt)
      const before = cellsOf(second.setup)
      clock.advance(AMBIENT_TICK_MS)
      await second.setup.renderOnce()
      expect(cellsOf(second.setup)).not.toBe(before)
      expect(clock.growth.ambient()).toBeGreaterThan(resumedAt)
    } finally {
      await second.setup.dispose()
    }
  })

  test("stops the sparkle while the terminal is unfocused and picks it up on focus", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 120, height: 40, growth: clock.growth, headerRows: 1 })
    try {
      clock.advance(7000)
      await setup.renderOnce()
      expect(clock.pending).toBe(true)

      setup.renderer.emit("blur" as never)
      await setup.renderOnce()
      expect(clock.pending).toBe(false)
      const paused = clock.growth.ambient()
      clock.advance(5000)
      await setup.renderOnce()
      expect(clock.growth.ambient()).toBe(paused)

      setup.renderer.emit("focus" as never)
      await setup.renderOnce()
      expect(clock.pending).toBe(true)
      clock.advance(AMBIENT_TICK_MS)
      expect(clock.growth.ambient()).toBeGreaterThan(paused)
    } finally {
      await setup.dispose()
    }
  })

  test("the plain tier schedules nothing at all", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 60, height: 12, growth: clock.growth })
    try {
      expect(setup.captureCharFrame()).toContain("BanyanCode")
      expect(clock.scheduled).toBe(0)
      expect(clock.pending).toBe(false)
      expect(clock.growth.ambient()).toBe(0)
    } finally {
      await setup.dispose()
    }
  })

  test("grows at 12 fps, then sparkles at 8 to 10 fps", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 120, height: 40, growth: clock.growth })
    try {
      expect(clock.delays).toEqual([GROWTH_TICK_MS])
      expect(GROWTH_TICK_MS).toBeCloseTo(1000 / 12)
      // Never faster than the growth clock, and not so slow it looks choppy.
      expect(AMBIENT_TICK_MS).toBeGreaterThanOrEqual(100)
      expect(AMBIENT_TICK_MS).toBeLessThanOrEqual(125)

      clock.advance(7000)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(true)
      expect(clock.delays).toEqual([GROWTH_TICK_MS, AMBIENT_TICK_MS])
      expect(clock.scheduled).toBe(2)
    } finally {
      await setup.dispose()
    }
  })

  test("schedules no timer at all when animations are off", async () => {
    let scheduled = 0
    const growth = createGrowth({
      animations: () => false,
      setInterval: ((fn: () => void, delay: number) => {
        void fn
        void delay
        scheduled += 1
        return 1 as unknown as Handle
      }) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    })
    const { setup } = await mountHero({ width: 120, height: 40, growth })
    try {
      expect(scheduled).toBe(0)
      expect(growth.done()).toBe(true)
      expect(growth.elapsed()).toBe(GROWTH_END)
      expect(growth.ambient()).toBe(GROWTH_END)
      const frame = setup.captureCharFrame()
      const cells = cellsOf(setup)
      await setup.renderOnce()
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toBe(frame)
      expect(cellsOf(setup)).toBe(cells)
      expect(cellsUpdated(setup)).toBe(0)
    } finally {
      await setup.dispose()
    }
  })
})

describe("BanyanHero growth", () => {
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
      // The plain tier draws no animated art, so it stops the clock instead of burning ticks.
      setup.resize(60, 12)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("BanyanCode")
      expect(clock.pending).toBe(false)
      // Back to a tier with art: the loop resumes where it left off.
      setup.resize(200, 55)
      await setup.renderOnce()
      expect(clock.pending).toBe(true)
      clock.advance(500)
      await setup.renderOnce()
      expect(clock.growth.done()).toBe(false)
      expect(clock.pending).toBe(true)
    } finally {
      await setup.dispose()
    }
  })
})
