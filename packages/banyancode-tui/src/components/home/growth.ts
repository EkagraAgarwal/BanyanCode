import { createSignal } from "solid-js"

/** Seconds until the Home tree is fully grown. */
export const GROWTH_END = 6.75

/** 12 fps for the growth itself. The interval owns the animation. */
export const GROWTH_TICK_MS = 1000 / 12

/**
 * 9 fps for the ambient sparkle that follows growth. The twinkle is a colour
 * flash on a still tree, so it reads the same a little slower, and every frame
 * it does not draw is a frame Home does not pay for.
 */
export const AMBIENT_TICK_MS = 1000 / 9

export type Growth = {
  /** Reactive seconds of growth, pinned to `GROWTH_END` once finished. */
  elapsed(): number
  /** Reactive seconds of the ambient loop: runs during growth and afterwards, frozen while paused. */
  ambient(): number
  /** Reactive, true once the final frame has been reached. */
  done(): boolean
  /** Idempotent: only the first call starts the clock (or jumps straight to finished when animations are off). */
  start(): void
  /** Skips growth and jumps to the final frame. The ambient loop keeps running unless paused. */
  finish(): void
  /** Stops the loop, keeping both clocks where they are. Idempotent; leaves no timer. */
  pause(): void
  /** Restarts the loop from the frozen clocks, or starts it on first use. Never replays growth. */
  resume(): void
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
  const [elapsedSignal, setElapsed] = createSignal(0)
  const [ambientSignal, setAmbient] = createSignal(0)
  const [done, setDone] = createSignal(false)
  let elapsed = 0
  let ambient = 0
  let started = false
  // Non-reactive on purpose: `run` is reached from a tracked effect, so reading
  // `done()` here would re-enter this write and recurse.
  let settled = false
  let timer: ReturnType<typeof setInterval> | undefined
  // Both clocks are measured against the instant the current timer was armed,
  // so switching the rate mid-flight restarts the measurement with no jump.
  let origin = 0
  let elapsedOrigin = 0
  let ambientOrigin = 0

  const stop = () => {
    if (timer === undefined) return
    cancel(timer)
    timer = undefined
  }
  const tick = () => {
    const dt = (now() - origin) / 1000
    // The ambient clock never stops once the tree is done: that is the sparkle.
    ambient = ambientOrigin + dt
    setAmbient(ambient)
    if (settled) return
    const next = elapsedOrigin + dt
    if (next >= GROWTH_END) settle()
    else {
      elapsed = next
      setElapsed(next)
    }
  }
  /** One timer at a time. A finished tree ticks at the ambient rate. */
  const arm = () => {
    const delay = settled ? AMBIENT_TICK_MS : GROWTH_TICK_MS
    stop()
    origin = now()
    elapsedOrigin = elapsed
    ambientOrigin = ambient
    timer = schedule(tick, delay)
  }
  const settle = () => {
    if (settled) return
    settled = true
    elapsed = GROWTH_END
    setElapsed(GROWTH_END)
    setDone(true)
    // The growth is over; from here the same clock drives the slower sparkle.
    if (timer !== undefined) arm()
  }
  // `animations: false` has no clock at all: one static final frame.
  const still = () => {
    if (settled) return
    settle()
    ambient = GROWTH_END
    setAmbient(GROWTH_END)
  }
  const run = () => {
    if (timer !== undefined) return
    if (!options.animations()) {
      still()
      return
    }
    arm()
  }

  return {
    elapsed: elapsedSignal,
    ambient: ambientSignal,
    done,
    start() {
      if (started) return
      started = true
      run()
    },
    finish() {
      started = true
      settle()
    },
    pause() {
      stop()
    },
    resume() {
      if (timer !== undefined) return
      started = true
      run()
    },
  }
}
