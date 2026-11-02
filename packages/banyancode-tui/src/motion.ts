import { RGBA } from "@opentui/core"
import { createEffect, createSignal, getOwner, onCleanup, onMount, type Accessor } from "solid-js"

/** The single refresh rate every moving surface shares. */
export const TICK_FPS = 12
export const TICK_MS = 1000 / TICK_FPS

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/** Ease-out `1 - (1 - p)^3`, clamped to `[0, 1]`. */
export function ease(p: number): number {
  return 1 - (1 - clamp01(p)) ** 3
}

/** Spring `1 - e^(-6p)·cos(9p)`, used for an overlay opening with a slight overshoot. */
export function spring(p: number): number {
  const value = clamp01(p)
  return 1 - Math.exp(-6 * value) * Math.cos(9 * value)
}

/** Gaussian falloff `e^(-d²/2σ²)`. A zero sigma is a hard spike. */
export function gauss(d: number, sigma: number): number {
  if (sigma <= 0) return d === 0 ? 1 : 0
  return Math.exp(-(d * d) / (2 * sigma * sigma))
}

/** Linear RGBA blend: `t = 0` is `a`, `t = 1` is `b`. Alpha blends too. */
export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const p = clamp01(t)
  if (p === 0) return a
  if (p === 1) return b
  return RGBA.fromValues(
    a.r + (b.r - a.r) * p,
    a.g + (b.g - a.g) * p,
    a.b + (b.b - a.b) * p,
    a.a + (b.a - a.a) * p,
  )
}

/**
 * One shared animation clock. Every subscriber shares a single interval, so a
 * screen with several moving parts still runs one timer. Two conditions keep
 * it at zero timers: at least one live subscriber, and `animations()` true
 * (the host's `context.ui.animations()` setting). The clock stops on the last
 * unsubscribe and on `dispose`.
 */
export interface Ticker {
  /** Reactive seconds of running time. Frozen while nothing is subscribed. */
  readonly time: Accessor<number>
  /** Reactive integer tick count. */
  readonly frame: Accessor<number>
  /** Reference-counted subscription. Returns the unsubscribe. */
  readonly subscribe: () => () => void
  readonly subscribers: Accessor<number>
  /** True while the shared interval exists. */
  readonly running: Accessor<boolean>
  readonly dispose: () => void
}

export function createTicker(options: {
  readonly animations?: () => boolean
  readonly now?: () => number
  readonly setInterval?: typeof setInterval
  readonly clearInterval?: typeof clearInterval
  readonly fps?: number
} = {}): Ticker {
  const now = options.now ?? (() => performance.now())
  const schedule = options.setInterval ?? setInterval
  const cancel = options.clearInterval ?? clearInterval
  const animations = options.animations ?? (() => true)
  const interval = 1000 / (options.fps ?? TICK_FPS)
  const [time, setTime] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const [subscribers, setSubscribers] = createSignal(0)
  const running = () => handle !== undefined
  let handle: ReturnType<typeof setInterval> | undefined
  let elapsed = 0
  let origin = 0

  const stop = () => {
    if (handle === undefined) return
    cancel(handle)
    handle = undefined
  }
  const start = () => {
    if (handle !== undefined || subscribers() === 0 || !animations()) return
    origin = now()
    handle = schedule(() => {
      if (!animations()) {
        stop()
        return
      }
      const current = now()
      elapsed += (current - origin) / 1000
      origin = current
      setTime(elapsed)
      setFrame((value) => value + 1)
    }, interval)
  }
  const sync = () => {
    if (subscribers() > 0 && animations()) start()
    else stop()
  }
  // A config toggle must take effect without a new subscription. Outside a
  // reactive owner (a plain unit test) there is nothing to track.
  if (getOwner() !== undefined) createEffect(sync)

  return {
    time,
    frame,
    subscribe() {
      setSubscribers((value) => value + 1)
      sync()
      let live = true
      return () => {
        if (!live) return
        live = false
        setSubscribers((value) => Math.max(0, value - 1))
        sync()
      }
    },
    subscribers,
    running,
    dispose() {
      stop()
      setSubscribers(0)
    },
  }
}

/**
 * Subscribe for the lifetime of the owning component. Pair with an `active()`
 * accessor so an idle surface holds no subscription and therefore no timer.
 */
export function useTickerWhen(ticker: Ticker, active: () => boolean): Accessor<number> {
  createEffect(() => {
    if (!active()) return
    onCleanup(ticker.subscribe())
  })
  return ticker.time
}

/** Subscribe for the lifetime of the owning component, regardless of work. */
export function useTicker(ticker: Ticker): Accessor<number> {
  onMount(() => onCleanup(ticker.subscribe()))
  return ticker.time
}
