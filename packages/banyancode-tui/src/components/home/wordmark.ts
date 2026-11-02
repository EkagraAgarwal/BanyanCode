import { RGBA } from "@opentui/core"
import { fadeIn, GROWTH_END } from "./growth"

/** The mockup's 5x7 bitmap font, packed into four rows of half blocks. */
const FONT: Record<string, readonly string[]> = {
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#.#.#", "#.#.#", "#..##", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
}

export const WORDMARK = "BANYANCODE"
/** Letters every 6 columns, minus the trailing gap the last letter does not need. */
export const WORDMARK_WIDTH = WORDMARK.length * 6 - 1
export const WORDMARK_HEIGHT = 4

const ADVANCE = 6
const REVEAL_START = 3.6
const REVEAL_STEP = 0.07
const REVEAL_FADE = 0.35
const HIGHLIGHT_START = 4.6
const HIGHLIGHT_FROM = -12
const HIGHLIGHT_SPEED = 40
const HIGHLIGHT_SIGMA = 5

const FULL = 0x2588
const UPPER = 0x2580
const LOWER = 0x2584

export type WordmarkCell = {
  readonly x: number
  readonly row: number
  readonly char: number
  /** Column offset from the word's left edge: the brightness gradient and the highlight read it. */
  readonly shade: number
  /** Seconds at which this letter starts fading in. */
  readonly reveal: number
}

export const WORDMARK_CELLS: readonly WordmarkCell[] = Array.from(WORDMARK).flatMap((letter, index) =>
  Array.from({ length: 5 }).flatMap((_, col) =>
    Array.from({ length: WORDMARK_HEIGHT }).flatMap((_, row) => {
      const top = FONT[letter]![row * 2]?.[col] === "#"
      const bottom = FONT[letter]![row * 2 + 1]?.[col] === "#"
      if (!top && !bottom) return []
      return [
        {
          x: index * ADVANCE + col,
          row,
          char: top && bottom ? FULL : top ? UPPER : LOWER,
          shade: index * ADVANCE + col,
          reveal: REVEAL_START + index * REVEAL_STEP,
        },
      ]
    }),
  ),
)

export type WordmarkPalette = {
  readonly bright: RGBA
  readonly leaf: RGBA
  readonly highlight: RGBA
  readonly background: RGBA
}

export type WordmarkFrame = {
  /** One color per `WORDMARK_CELLS` entry, replaced in place on every frame. */
  readonly colors: RGBA[]
  /** 0 until the letter has started fading in. */
  readonly visible: Uint8Array
}

export function createWordmarkFrame(): WordmarkFrame {
  return { colors: WORDMARK_CELLS.map(() => RGBA.fromInts(0, 0, 0)), visible: new Uint8Array(WORDMARK_CELLS.length) }
}

const baseScratch = RGBA.fromInts(0, 0, 0)
const toneScratch = RGBA.fromInts(0, 0, 0)

const mix = (out: RGBA, from: RGBA, to: RGBA, amount: number) => {
  const t = Math.max(0, Math.min(1, amount))
  out.r = from.r + (to.r - from.r) * t
  out.g = from.g + (to.g - from.g) * t
  out.b = from.b + (to.b - from.b) * t
  out.a = 1
  return out
}

/**
 * The wordmark at `t`: letters fade in left to right from the background, over a
 * left-to-right `bright`→`leaf` gradient, with one gaussian highlight that crosses
 * the word between 4.6s and `GROWTH_END` and leaves no residue.
 */
export function wordmarkFrame(
  t: number,
  palette: WordmarkPalette,
  frame: WordmarkFrame = createWordmarkFrame(),
): WordmarkFrame {
  const head = HIGHLIGHT_FROM + (t - HIGHLIGHT_START) * HIGHLIGHT_SPEED
  const lit = t >= HIGHLIGHT_START && t < GROWTH_END
  WORDMARK_CELLS.forEach((cell, index) => {
    const opacity = fadeIn(t, cell.reveal, REVEAL_FADE)
    frame.visible[index] = opacity > 0 ? 1 : 0
    if (opacity <= 0) return
    const base = mix(baseScratch, palette.bright, palette.leaf, cell.shade / (WORDMARK.length * ADVANCE))
    const glow = lit ? Math.exp(-((cell.shade - head) ** 2) / (2 * HIGHLIGHT_SIGMA ** 2)) : 0
    mix(frame.colors[index]!, palette.background, mix(toneScratch, base, palette.highlight, glow), opacity)
  })
  return frame
}
