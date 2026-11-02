import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { TREE_HEIGHT, TREE_WIDTH, treeFrame } from "../src/components/home/banyan-tree"
import { GROWTH_END } from "../src/components/home/growth"
import {
  WORDMARK,
  WORDMARK_CELLS,
  WORDMARK_HEIGHT,
  WORDMARK_WIDTH,
  wordmarkFrame,
} from "../src/components/home/wordmark"
import {
  TREE_COLUMNS,
  TREE_ROWS_AT_2_2,
  TREE_ROWS_AT_6,
  WORDMARK_COLUMNS,
  WORDMARK_ROWS_AT_6,
} from "./fixture/home-keyframes"

/** The ten rows the fixture covers start at this tree row (keyframe line 15 is terminal row 14). */
const FIXTURE_ROW = 13

const treeRows = (t: number) => {
  const frame = treeFrame(t)
  return Array.from({ length: TREE_HEIGHT }, (_, y) => {
    const row = Array.from({ length: TREE_WIDTH }, (_, x) => {
      const bits = frame.mask[y * TREE_WIDTH + x]!
      return bits ? String.fromCharCode(0x2800 + bits) : " "
    })
    return row.join("")
  })
}

const wordmarkRows = (t: number, palette: Parameters<typeof wordmarkFrame>[1]) => {
  const frame = wordmarkFrame(t, palette)
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
  test("matches the mockup's trunk and roots exactly at 2.2s", () => {
    const rows = treeRows(2.2)
    TREE_ROWS_AT_2_2.forEach((expected, index) => {
      expect(pad(rows[FIXTURE_ROW + index]!, TREE_COLUMNS)).toBe(pad(expected, TREE_COLUMNS))
    })
  })

  test("matches the mockup's trunk and roots exactly at 6s", () => {
    const rows = treeRows(6)
    TREE_ROWS_AT_6.forEach((expected, index) => {
      expect(pad(rows[FIXTURE_ROW + index]!, TREE_COLUMNS)).toBe(pad(expected, TREE_COLUMNS))
    })
  })

  test("starts from bare trunk and fills the whole grid by the end", () => {
    const start = treeFrame(0)
    const roles = new Set<number>()
    for (let index = 0; index < start.mask.length; index++) {
      if (start.mask[index]) roles.add(start.roles[index]!)
    }
    expect(roles.size).toBeGreaterThan(0)
    // Only bark and its wood mixes exist before any canopy or root has grown in.
    expect([...roles].every((role) => role >= 3)).toBe(true)
    const final = treeFrame(GROWTH_END)
    expect(final.mask).toHaveLength(TREE_WIDTH * TREE_HEIGHT)
    expect(final.roles).toHaveLength(TREE_WIDTH * TREE_HEIGHT)
    expect(final.mask.filter((bits) => bits !== 0).length).toBeGreaterThan(start.mask.filter((bits) => bits !== 0).length)
  })

  test("reuses the frame it is handed", () => {
    const frame = treeFrame(6)
    expect(treeFrame(2.2, frame)).toBe(frame)
  })
})

describe("wordmark", () => {
  test("draws BANYANCODE with the mockup's glyphs once revealed", () => {
    expect(WORDMARK).toBe("BANYANCODE")
    expect(WORDMARK_WIDTH).toBe(WORDMARK_COLUMNS)
    const rows = wordmarkRows(GROWTH_END, palette)
    WORDMARK_ROWS_AT_6.forEach((expected, index) => {
      expect(pad(rows[index]!, WORDMARK_COLUMNS)).toBe(pad(expected, WORDMARK_COLUMNS))
    })
  })

  test("reveals letters left to right and leaves no highlight residue at the end", () => {
    const early = wordmarkFrame(3.7, palette)
    expect(early.visible[0]).toBe(1)
    expect(early.visible[early.visible.length - 1]).toBe(0)

    const final = wordmarkFrame(GROWTH_END, palette)
    expect(final.visible.every((flag) => flag === 1)).toBe(true)
    // The left edge is the pure bright end of the gradient, so the highlight has fully passed.
    expect(final.colors[0]!.equals(palette.bright)).toBe(true)

    const during = wordmarkFrame(5.6, palette)
    const lit = during.colors.filter((color, index) => !color.equals(final.colors[index]!)).length
    expect(lit).toBeGreaterThan(0)
  })
})
