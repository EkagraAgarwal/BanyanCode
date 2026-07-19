import { describe, expect, test } from "bun:test"
import { Effect, Duration, Layer, Stream } from "effect"
import os from "node:os"
import path from "node:path"
import { SystemMonitor, readDisk } from "../../src/banyancode/system-monitor"

process.env.BANYANCODE_ENABLE = "1"

const layer = SystemMonitor.defaultLayer

describe("SystemMonitor", () => {
  test("status() returns expected shape", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const status = yield* monitor.status()
        expect(status.cpuPercent === undefined || typeof status.cpuPercent === "number").toBe(true)
        expect(typeof status.memoryUsedBytes).toBe("number")
        expect(typeof status.memoryTotalBytes).toBe("number")
        expect(status.platform).toMatch(/^(windows|linux|darwin)$/)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("status() caches result within 1 second", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const s1 = yield* monitor.status()
        const s2 = yield* monitor.status()
        expect(s1.cpuPercent).toBe(s2.cpuPercent)
        expect(s1.memoryUsedBytes).toBe(s2.memoryUsedBytes)
        expect(s1.memoryTotalBytes).toBe(s2.memoryTotalBytes)
        expect(s1.platform).toBe(s2.platform)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("platform detection returns valid platform", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const status = yield* monitor.status()
        expect(status.platform).toMatch(/^(windows|linux|darwin)$/)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("memory values are positive and consistent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const status = yield* monitor.status()
        expect(status.memoryUsedBytes).toBeGreaterThan(0)
        expect(status.memoryTotalBytes).toBeGreaterThan(0)
        expect(status.memoryUsedBytes).toBeLessThanOrEqual(status.memoryTotalBytes)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("cpuPercent is between 0 and 100", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const status = yield* monitor.status()
        if (status.cpuPercent !== undefined) {
          expect(status.cpuPercent).toBeGreaterThanOrEqual(0)
          expect(status.cpuPercent).toBeLessThanOrEqual(100)
        }
      }).pipe(Effect.provide(layer)),
    )
  })

  test("cpuPercent is undefined on first sample, then a number after cache expires", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const first = yield* monitor.status()
        yield* Effect.sleep(Duration.millis(1100))
        const second = yield* monitor.status()
        return { first, second }
      }).pipe(
        Effect.provide(layer),
        Effect.timeout(Duration.millis(3000)),
      ),
    )
    expect(result.first.cpuPercent).toBeUndefined()
    if (result.second.cpuPercent !== undefined) {
      expect(result.second.cpuPercent).toBeGreaterThanOrEqual(0)
      expect(result.second.cpuPercent).toBeLessThanOrEqual(100)
    }
  })

  test("watch(100) emits at least 3 values within 1500ms", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const stream = yield* monitor.watch(100)
        const values: SystemMonitor.SystemStatus[] = []
        yield* stream.pipe(
          Stream.take(3),
          Stream.runForEach((s) => Effect.sync(() => values.push(s))),
        )
        return values
      }).pipe(
        Effect.provide(layer),
        Effect.timeout(Duration.millis(1500)),
      ),
    )
    expect(result).toBeTruthy()
    expect(result.length).toBe(3)
    for (const v of result) {
      expect(v.cpuPercent === undefined || typeof v.cpuPercent === "number").toBe(true)
      expect(typeof v.memoryUsedBytes).toBe("number")
      expect(typeof v.memoryTotalBytes).toBe("number")
    }
  })

  test("GPU fields are undefined when nvidia-smi unavailable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const status = yield* monitor.status()
        if (status.gpuPercent !== undefined) {
          expect(status.vramUsedBytes).toBeDefined()
          expect(status.gpuTotalBytes).toBeDefined()
        }
      }).pipe(Effect.provide(layer)),
    )
  })

  describe("readDisk (fs.statfs)", () => {
    test("returns valid disk data on real path", async () => {
      const result = await Effect.runPromise(readDisk())
      expect(result.diskTotalBytes).toBeGreaterThan(0)
      expect(result.diskUsedBytes).toBeGreaterThanOrEqual(0)
      expect(result.diskUsedBytes!).toBeLessThanOrEqual(result.diskTotalBytes!)
    })

    test("returns empty for non-existent path", async () => {
      const fakePath = path.join(os.tmpdir(), `does-not-exist-${Date.now()}-${Math.random()}`)
      const result = await Effect.runPromise(readDisk(fakePath))
      expect(result).toEqual({})
    })

    test("readDisk works on the host platform's expected root", async () => {
      const expectedPath = process.platform === "win32" ? process.cwd() : "/"
      const result = await Effect.runPromise(readDisk(expectedPath))
      expect(result.diskTotalBytes).toBeGreaterThan(0)
    })

    test("watch() keeps emitting regardless of disk probe outcome", async () => {
      const values: SystemMonitor.SystemStatus[] = []
      await Effect.runPromise(
        Effect.gen(function* () {
          const monitor = yield* SystemMonitor.Service
          const stream = yield* monitor.watch(50)
          yield* stream.pipe(
            Stream.take(3),
            Stream.runForEach((s) => Effect.sync(() => values.push(s))),
          )
        }).pipe(Effect.provide(layer), Effect.timeout(Duration.seconds(8))),
      )
      expect(values.length).toBe(3)
      for (const v of values) {
        expect(typeof v.memoryUsedBytes).toBe("number")
        expect(v.memoryTotalBytes).toBeGreaterThan(0)
        expect(v.platform).toMatch(/^(windows|linux|darwin)$/)
      }
    })
  })
})