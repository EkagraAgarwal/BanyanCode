/**
 * Grove geometry: the pane grid and the branch row that sits above it. Pure
 * functions so the column formula, the pane centres and the junction glyphs
 * line up exactly, and can be checked without a renderer.
 */

/** The mockup's minimum pane width, before the 2-column gap. */
export const GROVE_PANE_MIN = 40
export const GROVE_GAP = 2
/** One pane plus its gap: the step the mockup's `columns` formula counts. */
export const GROVE_STEP = GROVE_PANE_MIN + GROVE_GAP
/** Below this width the Grove shows one pane beside a selectable list. */
export const GROVE_NARROW = 84

/** A narrow Grove: one pane plus the selectable list. */
export function groveNarrow(width: number): boolean {
  return width > 0 && width < GROVE_NARROW
}

export interface GroveGeometry {
  readonly width: number
  readonly columns: number
  readonly widths: readonly number[]
  /** Column of each pane's midpoint, from the row's left edge. */
  readonly centers: readonly number[]
}

/** `columns = floor((width + 2) / 42)`, never less than one. */
export function groveColumns(width: number): number {
  return Math.max(1, Math.floor((Math.max(0, Math.floor(width)) + GROVE_GAP) / GROVE_STEP))
}

/**
 * Pane widths for a row of `width` columns. Extra columns are handed to the
 * leftmost panes so the row always sums to exactly `width`.
 */
export function groveGeometry(width: number): GroveGeometry {
  const total = Math.max(0, Math.floor(width))
  const columns = groveColumns(total)
  const usable = Math.max(columns, total - GROVE_GAP * (columns - 1))
  const base = Math.floor(usable / columns)
  const extra = usable - base * columns
  const widths = Array.from({ length: columns }, (_, index) => base + (index < extra ? 1 : 0))
  let cursor = 0
  const centers = widths.map((paneWidth) => {
    const center = cursor + Math.floor(paneWidth / 2)
    cursor += paneWidth + GROVE_GAP
    return center
  })
  return { width: total, columns, widths, centers }
}

/** Left padding that centres `length` columns in `width`. */
export function groveCenterStart(width: number, length: number): number {
  return Math.max(0, Math.floor((width - length) / 2))
}

export interface GroveRowChars {
  readonly chars: readonly string[]
  /** Pane index that owns the column, or -1 for the trunk. */
  readonly owners: readonly number[]
}

const blank = (width: number) => Array.from({ length: Math.max(0, width) }, () => " ")

/**
 * The branch row: one horizontal arm from the trunk to each pane centre. Arms
 * grow from the trunk outward, so a 400 ms spawn fills `growth` from 0 to 1.
 */
export function groveJunctionRow(input: {
  readonly width: number
  readonly centers: readonly number[]
  readonly mid: number
  readonly growth?: readonly number[]
}): GroveRowChars {
  const width = Math.max(0, input.width)
  const chars = blank(width)
  const owners = Array.from({ length: width }, () => -1)
  const growth = input.centers.map((_, index) => clamp01(input.growth?.[index] ?? 1))
  const mid = input.mid

  input.centers.forEach((center, index) => {
    if (growth[index] === 0) return
    const reach = Math.round(Math.abs(center - mid) * growth[index]!)
    const from = Math.min(center, mid)
    const to = Math.max(center, mid)
    for (let x = from; x <= to; x++) {
      if (x < 0 || x >= width) continue
      if (Math.abs(x - mid) > reach) continue
      chars[x] = "─"
      owners[x] = index
    }
  })

  const left = input.centers.filter((center) => center < mid)
  const right = input.centers.filter((center) => center > mid)
  const leftmost = Math.min(...left)
  const rightmost = Math.max(...right)
  input.centers.forEach((center, index) => {
    if (growth[index]! < 1 || center < 0 || center >= width) return
    const glyph =
      center === mid
        ? "┼"
        : center < mid
          ? center === leftmost
            ? "╭"
            : "┬"
          : center === rightmost
            ? "╮"
            : "┬"
    chars[center] = glyph
    owners[center] = index
  })

  const grownLeft = input.centers.some((center, index) => center < mid && growth[index] === 1)
  const grownRight = input.centers.some((center, index) => center > mid && growth[index] === 1)
  const hasCenter = input.centers.some((center, index) => center === mid && growth[index] === 1)
  const atMid = hasCenter
    ? "┼"
    : grownLeft && grownRight
      ? "┴"
      : grownLeft
        ? "╯"
        : grownRight
          ? "╰"
          : " "
  if (atMid !== " " && mid >= 0 && mid < width) {
    chars[mid] = atMid
    owners[mid] = -1
  }
  return { chars, owners }
}

/** The drop row: one vertical arm per centre, `rows` deep. */
export function groveDropRow(input: {
  readonly width: number
  readonly centers: readonly number[]
  readonly rows: number
  readonly growth?: readonly number[]
}): GroveRowChars {
  const width = Math.max(0, input.width)
  const chars = blank(width)
  const owners = Array.from({ length: width }, () => -1)
  const centre = Math.max(0, Math.round(input.rows))
  input.centers.forEach((column, index) => {
    const visible = Math.round(centre * clamp01(input.growth?.[index] ?? 1))
    for (let row = 0; row < visible; row++) {
      if (column < 0 || column >= width) continue
      chars[column] = "│"
      owners[column] = index
    }
  })
  return { chars, owners }
}

/** Run-length encode a row so each run can carry its owner's colour. */
export function groveRuns(input: GroveRowChars): Array<{ readonly text: string; readonly owner: number }> {
  const runs: Array<{ text: string; owner: number }> = []
  input.chars.forEach((char, index) => {
    const owner = char === " " ? -1 : (input.owners[index] ?? -1)
    const last = runs.at(-1)
    if (last !== undefined && last.owner === owner) last.text += char
    else runs.push({ text: char, owner })
  })
  return runs
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
