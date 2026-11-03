/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { CellGrid, CellGridRenderable, Grid } from "../src/components/understory/cells"
import { mount } from "./harness"

const RED = RGBA.fromInts(255, 0, 0)
const GREEN = RGBA.fromInts(0, 255, 0)
const BLUE = RGBA.fromInts(0, 0, 255)
const BACKGROUND = RGBA.fromInts(0, 0, 0)

test("the grid writes glyphs, foregrounds, backgrounds and sub-cell blocks", () => {
  const grid = new Grid(12, 2)
  grid.clear(BACKGROUND)
  grid.text(0, 0, "abc", RED)
  grid.setCell(3, 0, "x", GREEN)
  grid.lowerBlock(4, 0, 4, RED, BLUE)
  grid.leftBlock(5, 0, 3, GREEN, BLUE)
  grid.fill(0, 1, 12, 1, BLUE)

  expect(grid.lines()[0]).toBe("abcx▄▍")
  const first = grid.cell(0, 0)!
  expect(first.glyph).toBe("a")
  expect(first.fg.equals(RED)).toBe(true)
  // A cell set without a background keeps the cleared one.
  expect(first.bg.equals(BACKGROUND)).toBe(true)
  expect(grid.cell(3, 0)!.fg.equals(GREEN)).toBe(true)
  // Lower block: foreground is the lower layer, background the upper one.
  expect(grid.cell(4, 0)!.fg.equals(RED)).toBe(true)
  expect(grid.cell(4, 0)!.bg.equals(BLUE)).toBe(true)
  // Left block: foreground is the left side, background the right one.
  expect(grid.cell(5, 0)!.fg.equals(GREEN)).toBe(true)
  expect(grid.cell(5, 0)!.bg.equals(BLUE)).toBe(true)
  expect(grid.cell(0, 1)!.bg.equals(BLUE)).toBe(true)
  expect(grid.cell(0, 1)!.glyph).toBe(" ")
})

test("sub-cell blocks cover every eighth, and full means the whole cell", () => {
  const grid = new Grid(9, 1)
  grid.clear(BACKGROUND)
  for (let eighths = 0; eighths <= 8; eighths += 1) grid.lowerBlock(eighths, 0, eighths, RED, BLUE)
  expect(grid.lines()[0]).toBe(" ▁▂▃▄▅▆▇█")

  const left = new Grid(9, 1)
  left.clear(BACKGROUND)
  for (let eighths = 0; eighths <= 8; eighths += 1) left.leftBlock(eighths, 0, eighths, GREEN, BLUE)
  expect(left.lines()[0]).toBe(" ▏▎▍▌▋▊▉█")
})

test("hit regions map a cell back to its id, and later regions win", () => {
  const grid = new Grid(10, 3)
  grid.clear(BACKGROUND)
  grid.hit(0, 0, 4, 1, "row:0")
  grid.hit(2, 0, 4, 3, "block:2")
  expect(grid.hitAt(0, 0)).toBe("row:0")
  expect(grid.hitAt(2, 0)).toBe("block:2")
  expect(grid.hitAt(5, 2)).toBe("block:2")
  expect(grid.hitAt(6, 0)).toBeUndefined()
  expect(grid.hitAt(-1, 0)).toBeUndefined()
})

test("CellGrid paints glyphs with their own fg and bg in one renderable", async () => {
  const app = await mount(
    () => (
      <CellGrid
        width={6}
        height={1}
        background={BACKGROUND}
        draw={(grid) => {
          grid.text(0, 0, "R", RED, BACKGROUND, true)
          grid.leftBlock(1, 0, 4, GREEN, BLUE)
          grid.lowerBlock(2, 0, 6, GREEN, BLUE)
          grid.hit(0, 0, 1, 1, "cell:R")
        }}
      />
    ),
    { width: 6, height: 1 },
  )
  try {
    await app.renderOnce()
    const line = app.captureCharFrame().split("\n")[0]!
    expect(line.startsWith("R▌▆")).toBe(true)

    const spans = app.captureSpans().lines[0]!.spans
    const glyph = spans.find((span) => span.text.includes("R"))
    expect(glyph).toBeDefined()
    expect(glyph!.fg.equals(RED)).toBe(true)
    expect(glyph!.bg.equals(BACKGROUND)).toBe(true)
    const split = spans.find((span) => span.text.includes("▌"))
    expect(split).toBeDefined()
    expect(split!.fg.equals(GREEN)).toBe(true)
    expect(split!.bg.equals(BLUE)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("twenty agents draw through one CellGrid, not twenty renderables", async () => {
  const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)]
  const counts: number[] = []
  for (const agents of [2, 20]) {
    const app = await mount(
      () => (
        <box flexDirection="column">
          <CellGrid
            width={24}
            height={agents}
            background={BACKGROUND}
            draw={(grid) => {
              for (let row = 0; row < agents; row += 1) {
                grid.text(0, row, `agent-${row}`, RED)
                grid.leftBlock(8, row, 4, GREEN, BLUE)
              }
            }}
          />
        </box>
      ),
      { width: 24, height: agents },
    )
    try {
      await app.renderOnce()
      const renderables = walk(app.renderer.root)
      expect(renderables.filter((node) => node instanceof CellGridRenderable)).toHaveLength(1)
      expect(app.captureCharFrame()).toContain(`agent-${agents - 1}`)
      counts.push(renderables.length)
    } finally {
      app.renderer.destroy()
    }
  }
  expect(counts[0]).toBe(counts[1])
})

test("a commit with identical cells asks for no frame, so an idle panel stays at zero", async () => {
  const [label, setLabel] = createSignal("build")
  const [unrelated, setUnrelated] = createSignal(0)
  let node: CellGridRenderable | undefined
  const app = await mount(
    () => (
      <CellGrid
        width={10}
        height={1}
        background={BACKGROUND}
        onReady={(value) => (node = value)}
        draw={(grid) => {
          unrelated()
          grid.text(0, 0, label(), RED)
        }}
      />
    ),
    { width: 10, height: 1 },
  )
  try {
    await app.renderOnce()
    expect(node).toBeDefined()
    expect(node!.commit()).toBe(false)

    setUnrelated(1)
    await app.renderOnce()
    expect(node!.commit()).toBe(false)

    setLabel("coder")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("coder")
    expect(node!.commit()).toBe(false)

    // Nothing here animates: the renderer holds no live node of its own.
    expect(app.renderer.root.liveCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a resized grid re-snapshots instead of reusing the old arrays", async () => {
  const [width, setWidth] = createSignal(4)
  const app = await mount(
    () => (
      <CellGrid
        width={width()}
        height={1}
        background={BACKGROUND}
        draw={(grid) => {
          grid.text(0, 0, "abcdefgh".slice(0, width()), RED)
        }}
      />
    ),
    { width: 8, height: 1 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[0]).toStartWith("abcd")

    setWidth(8)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[0]).toStartWith("abcdefgh")

    setWidth(2)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[0]).toStartWith("ab")
  } finally {
    app.renderer.destroy()
  }
})

test("a cell hit region resolves through the renderable's screen offset", async () => {
  const hits: string[] = []
  const app = await mount(
    () => (
      <box flexDirection="column">
        <CellGrid
          width={8}
          height={2}
          background={BACKGROUND}
          draw={(grid) => {
            grid.text(0, 1, "row", RED)
            grid.hit(0, 1, 3, 1, "row:1")
          }}
          onHit={(region) => hits.push(region)}
        />
      </box>
    ),
    { width: 8, height: 2 },
  )
  try {
    await app.renderOnce()
    await app.mockMouse.click(1, 1)
    expect(hits).toEqual(["row:1"])
  } finally {
    app.renderer.destroy()
  }
})
