import { expect, test } from "bun:test"
import {
  GROVE_GAP,
  groveCenterStart,
  groveColumns,
  groveDropRow,
  groveGeometry,
  groveJunctionRow,
  groveNarrow,
  groveRuns,
} from "../src/components/grove/layout"

test("the column formula is floor((width + 2) / 42) and never drops below one", () => {
  expect(groveColumns(200)).toBe(4)
  expect(groveColumns(168)).toBe(4)
  expect(groveColumns(126)).toBe(3)
  expect(groveColumns(120)).toBe(2)
  expect(groveColumns(100)).toBe(2)
  expect(groveColumns(84)).toBe(2)
  expect(groveColumns(83)).toBe(2)
  expect(groveColumns(42)).toBe(1)
  expect(groveColumns(10)).toBe(1)
  expect(groveColumns(0)).toBe(1)
})

test("narrow terminals get one pane plus a list", () => {
  expect(groveNarrow(83)).toBe(true)
  expect(groveNarrow(84)).toBe(false)
  expect(groveNarrow(200)).toBe(false)
  expect(groveNarrow(0)).toBe(false)
})

test("pane widths and two-column gaps add up to exactly the row width", () => {
  for (const width of [200, 168, 126, 120, 100, 84, 42]) {
    const geometry = groveGeometry(width)
    const total = geometry.widths.reduce((sum, pane) => sum + pane, 0) + GROVE_GAP * (geometry.columns - 1)
    expect(total).toBe(width)
    expect(geometry.widths.every((pane) => pane >= 40)).toBe(true)
    expect(geometry.centers.every((center) => center >= 0 && center < width)).toBe(true)
  }
})

test("extra width is handed to the panes, not left at the right edge", () => {
  const geometry = groveGeometry(168)
  expect(geometry.widths).toEqual([41, 41, 40, 40])
  expect(geometry.centers).toEqual([20, 63, 106, 148])
})

test("the branch row joins every pane centre with ╭ ┬ ┴ ╮", () => {
  const geometry = groveGeometry(168)
  const row = groveJunctionRow({ width: 168, centers: geometry.centers, mid: 84 })
  const text = row.chars.join("")
  expect(text[20]).toBe("╭")
  expect(text[63]).toBe("┬")
  expect(text[106]).toBe("┬")
  expect(text[148]).toBe("╮")
  expect(text[84]).toBe("┴")
  // Nothing between the arms is a hole.
  expect(text.slice(20, 149)).not.toContain(" ")
  // The arms are drawn outward from the trunk.
  expect(row.chars[0]).toBe(" ")
  expect(row.chars[167]).toBe(" ")
})

test("junction glyphs follow the side of the trunk", () => {
  const one = groveJunctionRow({ width: 100, centers: [23], mid: 50 })
  expect(one.chars.join("")).toContain("╭")
  expect(one.chars[50]).toBe("╯")
  const two = groveJunctionRow({ width: 100, centers: [23, 73], mid: 50 })
  expect(two.chars[23]).toBe("╭")
  expect(two.chars[73]).toBe("╮")
  expect(two.chars[50]).toBe("┴")
  const centre = groveJunctionRow({ width: 100, centers: [50], mid: 50 })
  expect(centre.chars[50]).toBe("┼")
})

test("a spawning branch grows from the trunk outward and keeps its pane's owner", () => {
  const geometry = groveGeometry(168)
  const empty = groveJunctionRow({ width: 168, centers: geometry.centers, mid: 84, growth: [0, 0, 0, 0] })
  expect(empty.chars.join("")).toBe(" ".repeat(168))
  const half = groveJunctionRow({ width: 168, centers: geometry.centers, mid: 84, growth: [0.5, 0, 0, 0] })
  expect(half.chars[20]).toBe(" ")
  expect(half.chars[62]).toBe("─")
  expect(half.chars[42]).toBe(" ")
  expect(half.owners[62]).toBe(0)
  expect(half.chars[84]).toBe("─")
  expect(half.owners[84]).toBe(0)
})

test("drop rows appear one row at a time", () => {
  const geometry = groveGeometry(168)
  const first = groveDropRow({ width: 168, centers: geometry.centers, rows: 1, growth: [1, 0, 1, 1] })
  expect(first.chars[20]).toBe("│")
  expect(first.chars[63]).toBe(" ")
  expect(first.chars[106]).toBe("│")
  expect(first.chars[148]).toBe("│")
  expect(first.owners[148]).toBe(3)
})

test("runs preserve every column, including the padding", () => {
  const row = groveDropRow({ width: 10, centers: [3], rows: 1 })
  const runs = groveRuns(row)
  expect(runs.map((run) => run.text).join("")).toHaveLength(10)
  expect(runs.at(0)).toMatchObject({ owner: -1 })
  expect(runs.some((run) => run.text.includes("│"))).toBe(true)
})

test("centre padding centres a label without going negative", () => {
  expect(groveCenterStart(168, 7)).toBe(80)
  expect(groveCenterStart(10, 20)).toBe(0)
})
