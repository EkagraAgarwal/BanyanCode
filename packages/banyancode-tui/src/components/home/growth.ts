import { createSignal } from "solid-js"

/** Seconds until the Home tree is fully grown. */
export const GROWTH_END = 6.75

/** 12 fps for both the growth and the ambient loop. The interval owns the animation. */
export const GROWTH_TICK_MS = 1000 / 12

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
  let timer: ReturnType<typeof setInterval> | undefined

  const settle = () => {
    elapsed = GROWTH_END
    setElapsed(GROWTH_END)
    setDone(true)
  }
  // `animations: false` has no clock at all: one static final frame.
  const still = () => {
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
    const origin = now()
    const elapsedOrigin = elapsed
    const ambientOrigin = ambient
    timer = schedule(() => {
      const dt = (now() - origin) / 1000
      ambient = ambientOrigin + dt
      setAmbient(ambient)
      if (elapsed >= GROWTH_END) return
      const next = elapsedOrigin + dt
      if (next >= GROWTH_END) settle()
      else {
        elapsed = next
        setElapsed(next)
      }
    }, GROWTH_TICK_MS)
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
      if (timer === undefined) return
      cancel(timer)
      timer = undefined
    },
    resume() {
      started = true
      run()
    },
  }
}
