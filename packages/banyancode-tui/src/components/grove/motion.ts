import { RGBA } from "@opentui/core"
import { ease, mix } from "../../motion"

/**
 * Grove motion, in seconds. The shared 12 fps ticker owns the clock; these
 * functions only say what a given age looks like, so they stay testable and
 * `animations: false` can use the same final answers.
 */

/** Spawn: horizontal arm 400 ms, drop 300 ms, then the pane unfolds 500 ms. */
export const GROVE_HORIZONTAL_S = 0.4
export const GROVE_DROP_S = 0.3
export const GROVE_UNFOLD_S = 0.5
/** Finish: a pulse travels from the pane to the trunk over 800 ms, then dims. */
export const GROVE_RETURN_S = 0.8
export const GROVE_DIM_S = 1.2
/** Waiting breathes amber towards the rule colour, about once a second. */
export const GROVE_BREATHE_S = 1

export interface GroveGrowth {
  /** 0–1 along the branch arm. */
  readonly horizontal: number
  /** 0–1 of the two drop rows. */
  readonly drop: number
  /** 0–1 of the pane's height. */
  readonly unfold: number
}

export function branchGrowth(age: number): GroveGrowth {
  return {
    horizontal: ease(age / GROVE_HORIZONTAL_S),
    drop: ease((age - GROVE_HORIZONTAL_S) / GROVE_DROP_S),
    unfold: ease((age - GROVE_HORIZONTAL_S - GROVE_DROP_S) / GROVE_UNFOLD_S),
  }
}

export interface GroveReturn {
  /** 0–1 from the pane's drop to the trunk. */
  readonly travel: number
  /** 0–1 of the dim after the pulse arrives. */
  readonly dim: number
}

export function returnPulse(age: number): GroveReturn {
  return {
    travel: ease(age / GROVE_RETURN_S),
    dim: ease((age - GROVE_RETURN_S) / GROVE_DIM_S),
  }
}

/** 0–1, a full cycle per `GROVE_BREATHE_S`. */
export function attentionBlend(time: number, period = GROVE_BREATHE_S): number {
  const phase = (Math.max(0, time) / Math.max(0.001, period)) * Math.PI * 2
  return 0.5 + 0.5 * Math.sin(phase)
}

/** Amber that never quite reaches the rule colour, so it keeps reading as waiting. */
export function attentionColor(amber: RGBA, line: RGBA, time: number): RGBA {
  return mix(amber, line, 0.25 + 0.35 * attentionBlend(time))
}

/** Rows of a pane shown at `unfold`, so a pane grows out of its branch. */
export function unfoldRows(height: number, unfold: number): number {
  if (unfold >= 1) return height
  if (unfold <= 0) return 0
  return Math.min(height, Math.max(3, Math.round(height * unfold)))
}
