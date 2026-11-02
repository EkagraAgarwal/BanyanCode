import type { RGBA } from "@opentui/core"
import { Show } from "solid-js"

/**
 * Sprout spinner frames. Kept in step with `SPROUT_FRAMES` in
 * `packages/tui/src/component/spinner-frames.ts`; the plugin cannot import the
 * host package without a package-level cycle (tui already depends on the
 * plugin), so the literal is mirrored here.
 */
export const SPROUT_FRAMES = [
  "⢀",
  "⣀",
  "⣄",
  "⣤",
  "⣦",
  "⣶",
  "⣷",
  "⣿",
  "⣾",
  "⣶",
  "⣦",
  "⣤",
  "⣄",
  "⣀",
] as const

export const SPROUT_FPS = 12

/** The frame for a clock in seconds. `offset` desynchronises neighbours. */
export function sproutFrame(tick: number, offset = 0): string {
  const step = Math.floor(Math.max(0, tick) * SPROUT_FPS + offset)
  return SPROUT_FRAMES[((step % SPROUT_FRAMES.length) + SPROUT_FRAMES.length) % SPROUT_FRAMES.length]!
}

/**
 * One spinner frame. Callers own the clock (the shared `Ticker`, so several
 * spinners never start several timers). With animations off it is the same
 * static `⋯` the host spinner falls back to.
 */
export function Sprout(props: {
  readonly tick: number
  readonly color: RGBA
  readonly animations?: boolean
  readonly offset?: number
  readonly still?: string
}) {
  return (
    <Show when={props.animations ?? true} fallback={<text fg={props.color}>{props.still ?? "⋯"}</text>}>
      <text fg={props.color}>{sproutFrame(props.tick, props.offset)}</text>
    </Show>
  )
}
