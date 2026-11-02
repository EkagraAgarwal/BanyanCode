/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA, type KeyEvent } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { Show, createSignal } from "solid-js"
import { BanyanHero, heroRows } from "../src/components/home/hero"
import { GROWTH_END, GROWTH_TICK_MS, createGrowth, type Growth } from "../src/components/home/growth"
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
  test("a keypress skips growth but the loop keeps going, and the input is not eaten", async () => {
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
      const before = cellsOf(setup)
      clock.advance(500)
      await setup.renderOnce()
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

  test("leaves move between two ambient times while the trunk stays put", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 120, height: 40, growth: clock.growth, headerRows: 1 })
    try {
      clock.advance(7000)
      await setup.renderOnce()
      const before = rowsOf(setup)
      clock.advance(500)
      await setup.renderOnce()
      const after = rowsOf(setup)
      // Rows 1..12 are canopy only; rows 18..23 hold the trunk and nothing else.
      expect(before.slice(1, 13).join("\n")).not.toBe(after.slice(1, 13).join("\n"))
      expect(before.slice(18, 24).join("\n")).toBe(after.slice(18, 24).join("\n"))
    } finally {
      await setup.dispose()
    }
  })

  test("keeps shimmering the wordmark in the compact tier", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 80, height: 20, growth: clock.growth })
    try {
      clock.advance(7000)
      await setup.renderOnce()
      const before = cellsOf(setup)
      clock.advance(500)
      await setup.renderOnce()
      expect(cellsOf(setup)).not.toBe(before)
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
    expect(clock.growth.ambient()).toBeGreaterThan(GROWTH_END)
    expect(setup.renderer.root.liveCount).toBe(0)
    expect(clock.pending).toBe(true)
    await setup.dispose()
    expect(clock.pending).toBe(false)
    expect(clock.growth.done()).toBe(true)
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

  test("ticks at no more than 12 fps", async () => {
    const clock = manualGrowth()
    const { setup } = await mountHero({ width: 120, height: 40, growth: clock.growth })
    try {
      expect(clock.delays).toEqual([GROWTH_TICK_MS])
      expect(GROWTH_TICK_MS).toBeCloseTo(1000 / 12)
      expect(clock.scheduled).toBe(1)
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
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toBe(frame)
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
