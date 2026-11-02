import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import {
  TREE_ROWS_SHORT,
  TREE_ROWS_TALL,
  TREE_WIDTH,
  createTreeFrame,
  treeFrame,
  treePointCount,
} from "../src/components/home/banyan-tree"
import { GROWTH_END } from "../src/components/home/growth"
import {
  WORDMARK,
  WORDMARK_CELLS,
  WORDMARK_HEIGHT,
  WORDMARK_WIDTH,
  wordmarkFrame,
} from "../src/components/home/wordmark"
import { FINAL_TREE_23, FINAL_TREE_27, WORDMARK_COLUMNS, WORDMARK_ROWS_AT_6 } from "./fixture/home-keyframes"

/** Roles a leaf can take: bright, mid, dark and the twinkle. */
const LEAF_ROLES = new Set([0, 1, 2, 7])

const finalFrame = (height: number) => treeFrame(GROWTH_END, GROWTH_END, createTreeFrame(height))

const treeRows = (height: number) =>
  finalFrame(height).mask.reduce<{ row: string[]; rows: string[] }>(
    (acc, bits, index) => {
      acc.row.push(bits ? String.fromCharCode(0x2800 + bits) : " ")
      if ((index + 1) % TREE_WIDTH === 0) {
        acc.rows.push(acc.row.join(""))
        acc.row = []
      }
      return acc
    },
    { row: [], rows: [] },
  ).rows

/** Left/right leaf extents of every row, plus the top/bottom leaf row of every column. */
function profile(height: number) {
  const { mask, roles } = finalFrame(height)
  const leaf = (x: number, y: number) => {
    const index = y * TREE_WIDTH + x
    return mask[index] !== 0 && LEAF_ROLES.has(roles[index]!)
  }
  const widths: number[] = []
  for (let y = 0; y < height; y++) {
    let first = -1
    let last = -1
    for (let x = 0; x < TREE_WIDTH; x++) {
      if (!leaf(x, y)) continue
      if (first < 0) first = x
      last = x
    }
    widths.push(first < 0 ? 0 : last - first + 1)
  }
  const columns: number[] = []
  for (let x = 0; x < TREE_WIDTH; x++) {
    for (let y = 0; y < height; y++) {
      if (!leaf(x, y)) continue
      columns.push(x)
      break
    }
  }
  const tops = columns.map((x) => {
    for (let y = 0; y < height; y++) if (leaf(x, y)) return y
    return -1
  })
  const bottoms = columns.map((x) => {
    for (let y = height - 1; y >= 0; y--) if (leaf(x, y)) return y
    return -1
  })
  return { widths, columns, tops, bottoms, first: widths.findIndex((width) => width > 0) }
}

/** Largest distance, in cells, between the row extents and their best-fit ellipse. */
function ellipseResidual(widths: number[]) {
  const points = widths.flatMap((width, y) => (width > 0 ? [{ y, h: width / 2 }] : []))
  const sum = (power: number) => points.reduce((total, point) => total + point.y ** power, 0)
  const sums = [points.length, sum(1), sum(2), sum(3), sum(4)]
  const rhs = [0, 1, 2].map((power) =>
    points.reduce((total, point) => total + point.y ** power * point.h ** 2, 0),
  )
  const matrix = [
    [sums[0]!, sums[1]!, sums[2]!],
    [sums[1]!, sums[2]!, sums[3]!],
    [sums[2]!, sums[3]!, sums[4]!],
  ]
  const determinant = (rows: number[][]) =>
    rows[0]![0]! * (rows[1]![1]! * rows[2]![2]! - rows[1]![2]! * rows[2]![1]!) -
    rows[0]![1]! * (rows[1]![0]! * rows[2]![2]! - rows[1]![2]! * rows[2]![0]!) +
    rows[0]![2]! * (rows[1]![0]! * rows[2]![1]! - rows[1]![1]! * rows[2]![0]!)
  const det = determinant(matrix)
  const solve = (column: number) =>
    determinant(matrix.map((row, index) => row.map((value, at) => (at === column ? rhs[index]! : value)))) / det
  const [a, b, c] = [solve(0), solve(1), solve(2)]
  return points.reduce((worst, point) => {
    const fitted = a! + b! * point.y + c! * point.y ** 2
    return Math.max(worst, Math.abs(point.h - Math.sqrt(Math.max(0, fitted))))
  }, 0)
}

const wordmarkRows = (elapsed: number, ambient: number, palette: Parameters<typeof wordmarkFrame>[2]) => {
  const frame = wordmarkFrame(elapsed, ambient, palette)
  const rows = Array.from({ length: WORDMARK_HEIGHT }, () => Array.from({ length: WORDMARK_WIDTH }, () => " "))
  WORDMARK_CELLS.forEach((cell, index) => {
    if (!frame.visible[index]) return
    rows[cell.row]![cell.x] = String.fromCharCode(cell.char)
  })
  return rows.map((row) => row.join(""))
}

const pad = (value: string, width: number) => value.padEnd(width, " ")

const palette = {
  bright: RGBA.fromInts(246, 250, 242),
  leaf: RGBA.fromInts(127, 214, 138),
  highlight: RGBA.fromInts(200, 242, 124),
  background: RGBA.fromInts(10, 14, 11),
}

describe("banyan tree", () => {
  test("is deterministic", () => {
    for (const height of [TREE_ROWS_SHORT, TREE_ROWS_TALL]) {
      const first = treeRows(height).join("\n")
      const second = treeRows(height).join("\n")
      expect(first).toBe(second)
      expect(first.length).toBeGreaterThan(0)
    }
  })

  test("keeps the crown between 76 and 82 cells at both heights", () => {
    for (const height of [TREE_ROWS_SHORT, TREE_ROWS_TALL]) {
      const { columns } = profile(height)
      const width = columns[columns.length - 1]! - columns[0]! + 1
      expect(width).toBeGreaterThanOrEqual(76)
      expect(width).toBeLessThanOrEqual(82)
    }
  })

  test("is not an ellipse: the row extents deviate from the best fit", () => {
    for (const height of [TREE_ROWS_SHORT, TREE_ROWS_TALL]) {
      const { widths } = profile(height)
      expect(ellipseResidual(widths)).toBeGreaterThan(2)
    }
  })

  test("has a bumpy top instead of one arc", () => {
    for (const height of [TREE_ROWS_SHORT, TREE_ROWS_TALL]) {
      const { tops } = profile(height)
      expect(new Set(tops).size).toBeGreaterThanOrEqual(4)
      const span = Math.max(...tops) - Math.min(...tops)
      expect(span).toBeGreaterThanOrEqual(4)
    }
  })

  test("hangs its leaves lower at the sides than in the middle", () => {
    for (const height of [TREE_ROWS_SHORT, TREE_ROWS_TALL]) {
      const { bottoms } = profile(height)
      const width = bottoms.length
      const deepest = (from: number, to: number) => Math.max(...bottoms.slice(from, to))
      // Outer quarters hang; the middle third stays clear of the trunk.
      const side = Math.max(deepest(0, Math.floor(width / 4)), deepest(width - Math.floor(width / 4), width))
      const middle = deepest(Math.floor(width * 0.4), Math.floor(width * 0.6))
      expect(side - middle).toBeGreaterThanOrEqual(2)
    }
  })

  test("keeps the trunk visible to the ground in the middle", () => {
    for (const height of [TREE_ROWS_SHORT, TREE_ROWS_TALL]) {
      const { mask } = finalFrame(height)
      const center = Math.floor(TREE_WIDTH / 2)
      for (let y = height - 6; y < height; y++) {
        const filled = [-2, -1, 0, 1, 2].filter((dx) => mask[y * TREE_WIDTH + center + dx] !== 0)
        expect(filled.length).toBeGreaterThanOrEqual(4)
      }
    }
  })

  test("stays inside the point budget", () => {
    expect(treePointCount(TREE_ROWS_SHORT)).toBeLessThan(25_000)
    expect(treePointCount(TREE_ROWS_TALL)).toBeLessThan(25_000)
  })

  test("matches the checked-in final frame at 23 rows", () => {
    expect(treeRows(TREE_ROWS_SHORT)).toEqual(FINAL_TREE_23)
  })

  test("matches the checked-in final frame at 27 rows", () => {
    expect(treeRows(TREE_ROWS_TALL)).toEqual(FINAL_TREE_27)
  })

  test("starts from bare trunk and reuses the frame it is handed", () => {
    const start = treeFrame(0, 0, createTreeFrame(TREE_ROWS_SHORT))
    const roles = new Set<number>()
    for (let index = 0; index < start.mask.length; index++) {
      if (start.mask[index]) roles.add(start.roles[index]!)
    }
    expect(roles.size).toBeGreaterThan(0)
    // Only bark and its wood mixes exist before any canopy or root has grown in.
    expect([...roles].every((role) => role >= 3)).toBe(true)
    const frame = createTreeFrame(TREE_ROWS_SHORT)
    expect(treeFrame(6, 6, frame)).toBe(frame)
  })
})

describe("wordmark", () => {
  test("draws BANYANCODE with the mockup's glyphs once revealed", () => {
    expect(WORDMARK).toBe("BANYANCODE")
    expect(WORDMARK_WIDTH).toBe(WORDMARK_COLUMNS)
    const rows = wordmarkRows(GROWTH_END, GROWTH_END, palette)
    WORDMARK_ROWS_AT_6.forEach((expected, index) => {
      expect(pad(rows[index]!, WORDMARK_COLUMNS)).toBe(pad(expected, WORDMARK_COLUMNS))
    })
  })

  test("reveals letters left to right", () => {
    const early = wordmarkFrame(3.7, 3.7, palette)
    expect(early.visible[0]).toBe(1)
    expect(early.visible[early.visible.length - 1]).toBe(0)
    const final = wordmarkFrame(GROWTH_END, GROWTH_END, palette)
    expect(final.visible.every((flag) => flag === 1)).toBe(true)
  })

  test("keeps looping its shimmer after the reveal", () => {
    const first = wordmarkFrame(GROWTH_END, 10, palette)
    const second = wordmarkFrame(GROWTH_END, 10.7, palette)
    const moved = first.colors.filter((color, index) => !color.equals(second.colors[index]!)).length
    expect(moved).toBeGreaterThan(0)
  })
})
