import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal(value)
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (next: T) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      set(() => next)
    }, ms)
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return [get, debounced]
}

export type CoalesceDecision = { action: "flush" } | { action: "schedule"; delayMs: number } | { action: "skip" }

/**
 * Trailing batch window for per-token part updates (V3/T8). Only the last
 * state in each window renders: ~30fps, matching the renderer's frame budget.
 * Text parts keep their own (longer) interval; reasoning and tool-output
 * deltas use this one.
 */
export const PART_RENDER_COALESCE_MS = 33

const LENGTH_SCALES = [
  { max: 4_096, ms: PART_RENDER_COALESCE_MS },
  { max: 16_384, ms: 100 },
  { max: 65_536, ms: 250 },
] as const

const LENGTH_SCALE_FALLBACK_MS = 500

/** Length-scaled coalesce interval: huge outputs re-render less often. Pure. */
export function coalesceMsForLength(chars: number): number {
  const length = Number.isFinite(chars) ? Math.max(0, Math.floor(chars)) : 0
  for (const scale of LENGTH_SCALES) {
    if (length <= scale.max) return scale.ms
  }
  return LENGTH_SCALE_FALLBACK_MS
}

/** Pure scheduler for createCoalescedAccessor — unit-testable without Solid effects. */
export function decideCoalesceFlush(input: {
  flushNow: boolean
  lastFlush: number
  now: number
  ms: number
  timerPending: boolean
}): CoalesceDecision {
  if (input.flushNow) return { action: "flush" }
  const elapsed = input.now - input.lastFlush
  if (elapsed >= input.ms) return { action: "flush" }
  if (input.timerPending) return { action: "skip" }
  return { action: "schedule", delayMs: input.ms - elapsed }
}

/**
 * Coalesce rapid source updates to at most one flush every `ms` while
 * `flushNow` is false (streaming). When `flushNow` becomes true (message
 * finished), apply the latest value immediately so the final render is not
 * delayed. Leading-edge: the first update in a quiet window flushes now.
 */
export function createCoalescedAccessor<T>(
  source: Accessor<T>,
  ms: number,
  flushNow: Accessor<boolean>,
): Accessor<T> {
  const [get, set] = createSignal(source())
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFlush = 0

  createEffect(() => {
    const next = source()
    const decision = decideCoalesceFlush({
      flushNow: flushNow(),
      lastFlush,
      now: Date.now(),
      ms,
      timerPending: timer !== undefined,
    })

    if (decision.action === "flush") {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      lastFlush = Date.now()
      set(() => next as T)
      return
    }

    if (decision.action === "skip") return

    timer = setTimeout(() => {
      timer = undefined
      lastFlush = Date.now()
      set(() => source() as T)
    }, decision.delayMs)
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  return get
}

export function createFadeIn(show: Accessor<boolean>, enabled: Accessor<boolean>) {
  const [alpha, setAlpha] = createSignal(show() ? 1 : 0)
  let revealed = show()

  createEffect(
    on([show, enabled], ([visible, animate]) => {
      if (!visible) {
        setAlpha(0)
        return
      }

      if (!animate || revealed) {
        revealed = true
        setAlpha(1)
        return
      }

      const start = performance.now()
      revealed = true
      setAlpha(0)

      const timer = setInterval(() => {
        const progress = Math.min((performance.now() - start) / 160, 1)
        setAlpha(progress * progress * (3 - 2 * progress))
        if (progress >= 1) clearInterval(timer)
      }, 16)

      onCleanup(() => clearInterval(timer))
    }),
  )

  return alpha
}
