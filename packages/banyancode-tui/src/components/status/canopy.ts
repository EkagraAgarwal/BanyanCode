import { gauss } from "../../motion"

/** Cells per second the highlight travels along the rule. */
export const CANOPY_SPEED = 38
/** Width of the main lobe in cells (one sigma). */
export const CANOPY_SIGMA = 9
/** The second, smaller lobe trails the first by this share of the rule width. */
export const CANOPY_SECOND_OFFSET = 0.55
export const CANOPY_SECOND_SIGMA = 5
export const CANOPY_SECOND_WEIGHT = 0.55
/** Colour steps the run list quantises to, so neighbouring cells merge. */
const CANOPY_LEVELS = 12

const BASE = "─"
const ACTIVE = "━"

/**
 * Highlight intensity at a column. Negative tick values count as zero so a
 * freshly mounted surface shows the first frame of the sweep.
 */
export function canopyLevel(x: number, tick: number, width: number): number {
  if (width <= 0) return 0
  const span = width + 40
  const time = Math.max(0, tick)
  const head = ((time * CANOPY_SPEED) % span) - 20
  const second = ((time * CANOPY_SPEED + width * CANOPY_SECOND_OFFSET) % span) - 20
  const level =
    gauss(x - head, CANOPY_SIGMA) + CANOPY_SECOND_WEIGHT * gauss(x - second, CANOPY_SECOND_SIGMA)
  return Math.min(1, Math.max(0, level))
}

export interface CanopyRun {
  readonly text: string
  /** 0..1 highlight intensity. The active segment is always 1. */
  readonly level: number
  /** True for the heavy, fully lit active-tab segment. */
  readonly active: boolean
}

/**
 * The canopy rule as colour runs, one row wide. Idle is a single unlit run:
 * no highlight, no timer, and nothing for the renderer to diff.
 */
export function canopyRuns(input: {
  readonly width: number
  readonly tick: number
  readonly busy: boolean
  readonly activeStart?: number
  readonly activeWidth?: number
}): CanopyRun[] {
  const width = Math.max(0, Math.floor(input.width))
  if (width === 0) return []
  const start = input.activeStart ?? -1
  const end = start < 0 ? -1 : start + Math.max(0, input.activeWidth ?? 0)
  const runs: Array<{ text: string; level: number; active: boolean }> = []
  for (let x = 0; x < width; x++) {
    const active = x >= start && x < end
    const level = active ? 1 : input.busy ? quantise(canopyLevel(x, input.tick, width)) : 0
    const char = active ? ACTIVE : BASE
    const previous = runs.at(-1)
    if (previous && previous.active === active && previous.level === level) {
      previous.text += char
      continue
    }
    runs.push({ text: char, level, active })
  }
  return runs
}

function quantise(level: number) {
  return Math.round(level * CANOPY_LEVELS) / CANOPY_LEVELS
}
