import type { RGBA } from "@opentui/core"
import { mix } from "../../../motion"
import type { Grid } from "../cells"

/**
 * The 2x4 braille dot grid the roots are drawn on (mockup lines 1155-1174).
 * Curves are accumulated here and flushed once, over blank or block cells only,
 * so a root never overdraws a label.
 */

/** Bit per dot: [left column top→bottom, right column top→bottom]. */
const BRAILLE = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const

const BRAILLE_BASE = 0x2800
const SPACE = 32
/** The block-elements range: separators and sub-cell fills a curve may cover. */
const BLOCK_FIRST = 0x2500
const BLOCK_LAST = 0x259f

export const BRAILLE_BLANK = BRAILLE_BASE

/** A block element, or a blank the braille layer is allowed to replace. */
export function overdrawable(glyph: string): boolean {
  const point = glyph.codePointAt(0) ?? SPACE
  return point === SPACE || point === 0x250a || (point >= BLOCK_FIRST && point <= BLOCK_LAST)
}

export class BrailleLayer {
  readonly cols: number
  readonly rows: number
  private bits: Uint8Array
  private colors: RGBA[]
  private powers: Float32Array

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, Math.floor(cols))
    this.rows = Math.max(0, Math.floor(rows))
    const size = this.cols * this.rows
    this.bits = new Uint8Array(size)
    this.colors = new Array<RGBA>(size)
    this.powers = new Float32Array(size)
  }

  clear(): void {
    this.bits.fill(0)
    this.powers.fill(0)
  }

  /** Sets one dot. A later dot at the same or higher power wins the colour. */
  plot(sx: number, sy: number, color: RGBA, power: number): void {
    const cx = Math.floor(sx / 2)
    const cy = Math.floor(sy / 4)
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return
    const index = cy * this.cols + cx
    this.bits[index]! |= BRAILLE[((sx % 2) + 2) % 2]![((sy % 4) + 4) % 4]!
    if (power >= this.powers[index]!) {
      this.powers[index] = power
      this.colors[index] = color
    }
  }

  glyphAt(x: number, y: number): string | undefined {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return undefined
    const bits = this.bits[y * this.cols + x]!
    return bits === 0 ? undefined : String.fromCodePoint(BRAILLE_BASE + bits)
  }

  /**
   * Paints the accumulated dots. Only a blank or a block element is replaced,
   * which is what keeps every tile label readable under a root.
   */
  flush(grid: Grid): void {
    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.cols; x += 1) {
        const index = y * this.cols + x
        const bits = this.bits[index]!
        if (bits === 0) continue
        const current = grid.cell(x, y)
        if (current === undefined || !overdrawable(current.glyph)) continue
        grid.setCell(x, y, String.fromCodePoint(BRAILLE_BASE + bits), this.colors[index]!)
      }
    }
  }
}

/** Cubic Bezier on one axis. */
export function bez(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const v = 1 - u
  return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3
}

export interface CurveOptions {
  readonly color: RGBA
  /** 0..1, carried into the dot power so crossings keep the fresher root. */
  readonly alpha: number
  /** 0..1 of the curve drawn so far; grows over 450 ms. */
  readonly grow?: number | undefined
  /** Comet positions along the curve, 0 at the start and 1 at the target. */
  readonly comets?: readonly number[] | undefined
  readonly cometColor?: RGBA | undefined
  readonly bold?: boolean | undefined
  readonly dash?: boolean | undefined
}

/**
 * A cubic from `(x0, y0)` to `(x1, y1)` in braille dot coordinates (mockup
 * lines 1162-1174). Control points are horizontal, so a root leaves the roster
 * flat and lands flat on its tile.
 */
export function drawCurve(
  layer: BrailleLayer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  options: CurveOptions,
): void {
  const dx = x1 - x0
  const c1 = x0 + dx * 0.5
  const c2 = x1 - dx * 0.45
  const steps = Math.ceil(Math.hypot(dx, y1 - y0) * 1.25) + 4
  const grow = options.grow ?? 1
  if (grow <= 0) return
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps
    if (u > grow) break
    if (options.dash === true && i % 6 > 3) continue
    const sx = Math.round(bez(x0, c1, c2, x1, u))
    const sy = Math.round(bez(y0, y0, y1, y1, u))
    let color = options.color
    let power = options.alpha
    for (const comet of options.comets ?? []) {
      const near = Math.exp(-((u - comet) ** 2) / (2 * 0.045 * 0.045))
      if (near <= 0.05) continue
      color = mix(color, options.cometColor ?? color, near)
      power = Math.max(power, near + 0.5)
      if (near > 0.45) {
        layer.plot(sx, sy + 1, color, power)
        layer.plot(sx, sy - 1, color, power)
      }
    }
    layer.plot(sx, sy, color, power)
    if (options.bold === true) layer.plot(sx, sy + 1, color, power)
  }
}
