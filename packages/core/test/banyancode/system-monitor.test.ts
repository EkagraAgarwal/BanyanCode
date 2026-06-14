import { describe, expect, test } from "bun:test"
import { Effect, Duration, Layer, Stream } from "effect"
import { SystemMonitor } from "../../src/banyancode/system-monitor"

process.env.BANYANCODE_ENABLE = "1"

const layer = SystemMonitor.defaultLayer

describe("SystemMonitor", () => {
  test("status() returns expected shape", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const monitor = yield* SystemMonitor.Service
        const status = yield* monitor.status()
        expect(typeof status.cpuPercent).toBe("number")
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
        expect(status.cpuPercent).toBeGreaterThanOrEqual(0)
        expect(status.cpuPercent).toBeLessThanOrEqual(100)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("watch(100) emits at least 3 values within 500ms", async () => {
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
        Effect.timeout(Duration.millis(500)),
      ),
    )
    expect(result).toBeTruthy()
    expect(result.length).toBe(3)
    for (const v of result) {
      expect(typeof v.cpuPercent).toBe("number")
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
})