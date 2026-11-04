import { describe, expect, test } from "bun:test"
import {
  AMBIENT_TICK_MS,
  GROWTH_END,
  GROWTH_TICK_MS,
  createGrowth,
  fadeIn,
} from "../src/components/home/growth"

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
  test("starts one clock at 12 fps", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    expect(growth.elapsed()).toBe(0)
    expect(growth.ambient()).toBe(0)
    expect(growth.done()).toBe(false)
    growth.start()
    growth.start()
    growth.resume()
    expect(clock.scheduled).toBe(1)
    expect(clock.delays).toEqual([GROWTH_TICK_MS])
    expect(GROWTH_TICK_MS).toBeCloseTo(1000 / 12)
    expect(AMBIENT_TICK_MS).toBeGreaterThanOrEqual(GROWTH_TICK_MS)
  })

  test("reads the injected clock instead of the wall clock", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(250)
    expect(growth.elapsed()).toBeCloseTo(0.25)
    expect(growth.ambient()).toBeCloseTo(0.25)
    expect(growth.done()).toBe(false)
    clock.advance(250)
    expect(growth.elapsed()).toBeCloseTo(0.5)
    expect(growth.ambient()).toBeCloseTo(0.5)
  })

  test("animations off finishes immediately without scheduling anything", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => false, ...clock })
    growth.start()
    growth.resume()
    expect(clock.scheduled).toBe(0)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.ambient()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
  })

  test("keeps the ambient loop running past the end of growth", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(6000)
    expect(clock.pending).toBe(true)
    clock.advance(1000)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
    // The tree has landed but Home still sparkles: the clock keeps one timer,
    // now at the slower ambient rate.
    expect(clock.pending).toBe(true)
    expect(clock.delays).toEqual([GROWTH_TICK_MS, AMBIENT_TICK_MS])
    expect(clock.scheduled).toBe(2)
    expect(clock.cleared).toBe(1)
    const ambient = growth.ambient()
    clock.advance(500)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.ambient()).toBeCloseTo(ambient + 0.5)
  })

  test("sparkles indefinitely without replaying growth", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(6000)
    clock.advance(1000)
    const start = growth.ambient()
    for (let i = 0; i < 60; i += 1) clock.advance(500)
    expect(growth.ambient()).toBeCloseTo(start + 30)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
    expect(clock.pending).toBe(true)
  })

  test("finish skips growth but leaves the loop running", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(120)
    expect(growth.elapsed()).toBeCloseTo(0.12)
    growth.finish()
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
    expect(clock.pending).toBe(true)
    expect(clock.delays).toEqual([GROWTH_TICK_MS, AMBIENT_TICK_MS])
    const ambient = growth.ambient()
    clock.advance(500)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.ambient()).toBeCloseTo(ambient + 0.5)
  })

  test("pause drops the timer and freezes both clocks", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(1000)
    growth.pause()
    expect(clock.pending).toBe(false)
    clock.advance(5000)
    expect(growth.elapsed()).toBeCloseTo(1)
    expect(growth.ambient()).toBeCloseTo(1)
    growth.pause()
    expect(clock.cleared).toBe(1)
  })

  test("resume continues the loop without replaying growth", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(6000)
    clock.advance(1000)
    expect(growth.done()).toBe(true)
    growth.pause()
    clock.advance(60_000)
    const ambient = growth.ambient()
    growth.resume()
    expect(clock.pending).toBe(true)
    expect(clock.delays[clock.delays.length - 1]).toBe(AMBIENT_TICK_MS)
    clock.advance(250)
    expect(growth.elapsed()).toBe(GROWTH_END)
    expect(growth.done()).toBe(true)
    expect(growth.ambient()).toBeCloseTo(ambient + 0.25)
  })

  test("resume mid-growth continues from where it paused", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    clock.advance(1000)
    growth.pause()
    growth.resume()
    clock.advance(250)
    expect(growth.elapsed()).toBeCloseTo(1.25)
    expect(clock.delays).toEqual([GROWTH_TICK_MS, GROWTH_TICK_MS])
  })

  test("start after finish does not replay", () => {
    const clock = manual()
    const growth = createGrowth({ animations: () => true, ...clock })
    growth.start()
    growth.finish()
    growth.start()
    expect(clock.scheduled).toBe(2)
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
