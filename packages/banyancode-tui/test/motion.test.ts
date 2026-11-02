import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createTicker, ease, gauss, mix, spring, TICK_MS } from "../src/motion"

/** Records scheduled intervals so a test can drive them and count timers. */
function fakeClock(start = 0) {
  const timers = new Map<number, () => void>()
  let next = 1
  let scheduled = 0
  let cleared = 0
  let clock = start
  return {
    options: {
      now: () => clock,
      setInterval: ((fn: () => void) => {
        const id = next++
        timers.set(id, fn)
        scheduled++
        return id as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: ((id: unknown) => {
        if (timers.delete(id as number)) cleared++
      }) as unknown as typeof clearInterval,
    },
    tick(ms: number) {
      clock += ms
      for (const fn of [...timers.values()]) fn()
    },
    timers: () => ({ scheduled, cleared, live: timers.size }),
  }
}

test("easing curves match the motion spec", () => {
  expect(ease(0)).toBe(0)
  expect(ease(0.5)).toBeCloseTo(0.875, 6)
  expect(ease(1)).toBe(1)
  expect(ease(-1)).toBe(0)
  expect(ease(2)).toBe(1)

  expect(spring(0)).toBeCloseTo(0, 6)
  expect(spring(1)).toBeCloseTo(1, 2)
  // The curve overshoots before it settles, which is the point of a spring.
  expect(spring(0.35)).toBeGreaterThan(1)

  expect(gauss(0, 9)).toBe(1)
  expect(gauss(9, 9)).toBeCloseTo(Math.exp(-0.5), 6)
  expect(gauss(0, 0)).toBe(1)
  expect(gauss(3, 0)).toBe(0)
})

test("mix blends RGBA channels and returns its endpoints unchanged", () => {
  const black = RGBA.fromInts(0, 0, 0)
  const white = RGBA.fromInts(255, 255, 255)
  expect(mix(black, white, 0)).toBe(black)
  expect(mix(black, white, 1)).toBe(white)
  const half = mix(black, white, 0.5).toInts()
  expect(half[0]).toBe(128)
  expect(half[1]).toBe(128)
  expect(half[2]).toBe(128)
  expect(half[3]).toBe(255)
})

test("an idle ticker holds no timer and no subscription", () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  expect(ticker.running()).toBe(false)
  expect(clock.timers()).toEqual({ scheduled: 0, cleared: 0, live: 0 })
  expect(ticker.subscribers()).toBe(0)
})

test("several subscribers share one 12 fps interval", () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const first = ticker.subscribe()
  const second = ticker.subscribe()
  expect(ticker.subscribers()).toBe(2)
  expect(clock.timers().scheduled).toBe(1)
  expect(ticker.running()).toBe(true)
  expect(TICK_MS).toBeCloseTo(1000 / 12, 6)

  clock.tick(1000)
  expect(ticker.time()).toBeCloseTo(1, 6)
  expect(ticker.frame()).toBe(1)

  first()
  expect(clock.timers().cleared).toBe(0)
  expect(ticker.running()).toBe(true)
  second()
  expect(clock.timers().cleared).toBe(1)
  expect(ticker.running()).toBe(false)
  expect(ticker.subscribers()).toBe(0)
})

test("animations off subscribes nothing at the host", () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => false, ...clock.options })
  const unsubscribe = ticker.subscribe()
  expect(clock.timers().scheduled).toBe(0)
  expect(ticker.running()).toBe(false)
  expect(ticker.time()).toBe(0)
  unsubscribe()
})

test("dispose stops the shared timer and drops every subscriber", () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  ticker.subscribe()
  ticker.subscribe()
  expect(clock.timers().live).toBe(1)
  ticker.dispose()
  expect(clock.timers().live).toBe(0)
  expect(ticker.subscribers()).toBe(0)
  expect(ticker.running()).toBe(false)
})

test("unsubscribing twice does not drop another subscriber's timer", () => {
  const clock = fakeClock()
  const ticker = createTicker({ animations: () => true, ...clock.options })
  const first = ticker.subscribe()
  ticker.subscribe()
  first()
  first()
  expect(ticker.subscribers()).toBe(1)
  expect(ticker.running()).toBe(true)
})
