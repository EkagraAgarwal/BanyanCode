import { describe, expect, test } from "bun:test"
import { GROWTH_END, GROWTH_TICK_MS, createGrowth, fadeIn } from "../src/components/home/growth"

type Handle = ReturnType<typeof setInterval>

function manual() {
  let time = 0
  let tick: (() => void) | undefined
  let scheduled = 0
  let cleared = 0
  const delays: number[] = []
  return {
    now: () => time,
    setInterval: ((fn: () => void, delay: number) => {
      scheduled += 1
      delays.push(delay)
      tick = fn
      return scheduled as unknown as Handle
    }) as typeof setInterval,
    clearInterval: (() => {
      cleared += 1
      tick = undefined
    }) as typeof clearInterval,
    advance(ms: number) {
      time += ms
      tick?.()
    },
    get scheduled() {
      return scheduled
    },
    get cleared() {
      return cleared
    },
    get delays() {
      return delays
    },
    get pending() {
      return tick !== undefined
    },
  }
}

describe("createGrowth", () => {
  test("starts the clock once at 12 fps", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    expect(growth.elapsed()).toBe(0)
    expect(growth.done()).toBe(false)
    growth.start()
    growth.start()
    expect(clock.scheduled).toBe(1)
    expect(clock.delays).toEqual([GROWTH_TICK_MS])
    expect(GROWTH_TICK_MS).toBeCloseTo(1000 / 12)
  })

  test("reads the injected clock instead of the wall clock", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(250)
    expect(growth.elapsed()).toBeCloseTo(0.25)
    expect(growth.done()).toBe(false)
    clock.advance(250)
    expect(growth.elapsed()).toBeCloseTo(0.5)
  })

  test("animations off finishes immediately without scheduling anything", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => false, ...clock })
    growth.start()
    expect(clock.scheduled).toBe(0)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
  })

  test("finish clears the timer and jumps to the final frame", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(120)
    expect(growth.elapsed()).toBeCloseTo(0.12)
    growth.finish()
    expect(clock.pending).toBe(false)
    expect(clock.cleared).toBe(1)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
    growth.finish()
    expect(clock.cleared).toBe(1)
  })

  test("leaves no timer behind once it reaches the end", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(6000)
    expect(clock.pending).toBe(true)
    clock.advance(1000)
    expect(clock.pending).toBe(false)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
    clock.advance(60_000)
    expect(growth.elapsed()).toBe(GROWTH_END)
  })

  test("start after finish does not replay", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    growth.finish()
    growth.start()
    expect(clock.scheduled).toBe(1)
    expect(clock.pending).toBe(false)
    expect(growth.elapsed()).toBe(GROWTH_END)
  })

  test("fadeIn eases out and clamps", () => {
    expect(fadeIn(0, 0, 1)).toBe(0)
    expect(fadeIn(-1, 0, 1)).toBe(0)
    expect(fadeIn(0.5, 0, 1)).toBe(0.875)
    expect(fadeIn(1, 0, 1)).toBe(1)
    expect(fadeIn(4, 0, 1)).toBe(1)
    expect(fadeIn(3.6 + 0.35, 3.6, 0.35)).toBe(1)
  })
})
