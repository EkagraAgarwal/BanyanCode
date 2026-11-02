import { createSignal } from "solid-js"

/** Seconds until the Home tree is fully grown. The last frame is cached and never replays. */
export const GROWTH_END = 6.75

/** 12 fps. The interval owns the animation; the renderer stays idle between ticks. */
export const GROWTH_TICK_MS = 1000 / 12

export type Growth = {
  /** Reactive seconds of growth, pinned to `GROWTH_END` once finished. */
  elapsed(): number
  /** Reactive, true once the final frame has been reached. */
  done(): boolean
  /** Idempotent: only the first call starts the clock (or jumps straight to finished when animations are off). */
  start(): void
  /** Clears the timer and jumps to the final frame. Idempotent. */
  finish(): void
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

/** Ease-out `1 - (1 - p)^3` for `p` over `[start, start + duration]`. */
export function fadeIn(elapsed: number, start: number, duration: number) {
  return 1 - (1 - clamp((elapsed - start) / duration)) ** 3
}

export function createGrowth(options: {
  animations: () => boolean
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}): Growth {
  const now = options.now ?? (() => performance.now())
  const schedule = options.setInterval ?? setInterval
  const cancel = options.clearInterval ?? clearInterval
  const [elapsed, setElapsed] = createSignal(0)
  const [done, setDone] = createSignal(false)
  let started = false
  let timer: ReturnType<typeof setInterval> | undefined
  // A finished tree is final: clear the timer first so no tick can resurrect it.
  const settle = () => {
    if (timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
    setElapsed(GROWTH_END)
    setDone(true)
  }
  return {
    elapsed,
    done,
    start() {
      if (started) return
      started = true
      if (!options.animations()) {
        settle()
        return
      }
      const origin = now()
      timer = schedule(() => {
        const next = (now() - origin) / 1000
        if (next >= GROWTH_END) settle()
        else setElapsed(next)
      }, GROWTH_TICK_MS)
    },
    finish() {
      started = true
      settle()
    },
  }
}
