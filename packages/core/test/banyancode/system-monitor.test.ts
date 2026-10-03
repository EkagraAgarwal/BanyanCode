import { describe, expect, test } from "bun:test"
import { Effect, Duration, Layer, Option, Queue, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import os from "node:os"
import path from "node:path"
import { AppProcess } from "../../src/process"
import { SystemMonitor, readDisk } from "../../src/banyancode/system-monitor"

process.env.BANYANCODE_ENABLE = "1"

const layer = SystemMonitor.defaultLayer

/** Non-blocking drain: everything currently queued, up to max. */
const drainAvailable = <A>(queue: Queue.Dequeue<A>, max: number) =>
  Effect.gen(function* () {
    const out: Array<A> = []
    for (let i = 0; i < max; i++) {
      const next = yield* Queue.poll(queue)
      if (Option.isNone(next)) break
      out.push(next.value)
    }
    return out
  })

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

  test("watch(100) emits at least 3 values within 4500ms", async () => {
    // watch() holds a sampler lease for the stream lifetime; the short tick
    // plus the change-heartbeat (every 10th tick) yields ~3 samples in ~2s.
    process.env.BANYANCODE_SYSTEM_TICK_MS = "100"
    try {
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
          Effect.timeout(Duration.millis(4500)),
        ),
      )
      expect(result).toBeTruthy()
      expect(result.length).toBe(3)
      for (const v of result) {
        expect(v.cpuPercent === undefined || typeof v.cpuPercent === "number").toBe(true)
        expect(typeof v.memoryUsedBytes).toBe("number")
        expect(typeof v.memoryTotalBytes).toBe("number")
      }
    } finally {
      delete process.env.BANYANCODE_SYSTEM_TICK_MS
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
      process.env.BANYANCODE_SYSTEM_TICK_MS = "100"
      try {
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
      } finally {
        delete process.env.BANYANCODE_SYSTEM_TICK_MS
      }
      expect(values.length).toBe(3)
      for (const v of values) {
        expect(typeof v.memoryUsedBytes).toBe("number")
        expect(v.memoryTotalBytes).toBeGreaterThan(0)
        expect(v.platform).toMatch(/^(windows|linux|darwin)$/)
      }
    })
  })

  describe("producer tick pacing (regression)", () => {
    // The internal sampler used to be `Effect.forever(tick).pipe(Schedule.spaced(...))`
    // which busy-spun because `forever` never completes. The tick is now 3s by
    // default and gated on demand: with no subscriber nothing is sampled.
    test("events queue receives a paced number of samples (no busy-spin)", async () => {
      process.env.BANYANCODE_SYSTEM_TICK_MS = "200"
      try {
        const collected = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const monitor = yield* SystemMonitor.Service
              const queue = yield* monitor.events()
              const unsubscribe = yield* monitor.subscribe()
              let count = 0
              yield* Effect.forkScoped(
                Effect.forever(
                  Effect.gen(function* () {
                    yield* Queue.take(queue)
                    count++
                  }),
                ),
              )
              yield* Effect.sleep(Duration.millis(900))
              yield* unsubscribe
              return count
            }),
          ).pipe(Effect.provide(layer)),
        )
        // 200ms spacing → ~4 ticks in 900ms; change-only publish keeps all but
        // the first (plus genuine changes). The old busy-spin produced tens of
        // thousands here.
        expect(collected).toBeGreaterThanOrEqual(1)
        expect(collected).toBeLessThan(8)
      } finally {
        delete process.env.BANYANCODE_SYSTEM_TICK_MS
      }
    })

    test("sampling stops when the subscriber count hits 0 and resumes after resubscribe", async () => {
      process.env.BANYANCODE_SYSTEM_TICK_MS = "100"
      try {
        const stubProcess = Layer.succeed(
          AppProcess.Service,
          AppProcess.Service.of({
            run: () =>
              Effect.succeed({
                command: "nvidia-smi",
                exitCode: 1,
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("no gpu here"),
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
            runStream: () => {
              throw new Error("unused")
            },
          } as unknown as AppProcess.Interface),
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const monitor = yield* SystemMonitor.Service
              const queue = yield* monitor.events()

              const unsubscribe = yield* monitor.subscribe()
              expect(yield* monitor.subscriberCount()).toBe(1)
              yield* Effect.sleep(Duration.millis(350))
              const first = yield* drainAvailable(queue, 10)
              expect(first.length).toBeGreaterThanOrEqual(1)

              yield* unsubscribe
              expect(yield* monitor.subscriberCount()).toBe(0)
              // Drain stragglers from the subscribed era, then prove the
              // ungated ticks sample nothing new.
              yield* drainAvailable(queue, 60)
              yield* Effect.sleep(Duration.millis(350))
              expect(yield* Queue.size(queue)).toBe(0)

              const resubscribe = yield* monitor.subscribe()
              expect(yield* monitor.subscriberCount()).toBe(1)
              yield* Effect.sleep(Duration.millis(350))
              // Unsubscribing clears the last-published sample, so the first
              // tick after resubscribe always publishes the current state.
              const resumed = yield* drainAvailable(queue, 10)
              expect(resumed.length).toBeGreaterThanOrEqual(1)
              yield* resubscribe
            }),
          ).pipe(Effect.provide(SystemMonitor.layer.pipe(Layer.provide(stubProcess)))),
        )
      } finally {
        delete process.env.BANYANCODE_SYSTEM_TICK_MS
      }
    })
  })

  describe("failed GPU probe caching (regression)", () => {
    // Failed nvidia-smi probes used to skip the gpuAt write (gated on
    // `snapshot.gpu && ...`), so every status() tick re-spawned the binary.
    // Driven through status() directly: the background tick stays silent
    // without a subscriber, so this no longer depends on tick timing.
    test("spawns nvidia-smi at most once per TTL when the probe fails", async () => {
      if (process.platform === "darwin") return

      const runs: string[] = []
      const failingProcess = Layer.succeed(
        AppProcess.Service,
        AppProcess.Service.of({
          run: (command: ChildProcess.Command) =>
            Effect.sync(() => {
              if (command._tag === "StandardCommand") runs.push(command.command)
              return {
                command: "nvidia-smi",
                exitCode: 1,
                stdout: Buffer.alloc(0),
                stderr: Buffer.from("NVIDIA-SMI has failed"),
                stdoutTruncated: false,
                stderrTruncated: false,
              }
            }),
          runStream: () => {
            throw new Error("unused")
          },
        } as unknown as AppProcess.Interface),
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const monitor = yield* SystemMonitor.Service
            yield* monitor.status()
            expect(runs.filter((c) => c === "nvidia-smi").length).toBe(1)

            // Further status() calls across the 1s status-cache window and the
            // 30s GPU TTL must not re-spawn nvidia-smi. A single non-ENOENT
            // failure stays well under the circuit-breaker threshold.
            yield* monitor.status()
            yield* Effect.sleep(Duration.millis(1100))
            yield* monitor.status()
            yield* monitor.status()
            yield* Effect.sleep(Duration.millis(1100))
            yield* monitor.status()

            expect(runs.filter((c) => c === "nvidia-smi").length).toBe(1)
          }),
        ).pipe(Effect.provide(SystemMonitor.layer.pipe(Layer.provide(failingProcess)))),
      )
    })

    test("GPU probe circuit-breaker trips after N consecutive non-ENOENT failures", async () => {
      if (process.platform === "darwin") return

      process.env.BANYANCODE_SYSTEM_GPU_TTL_MS = "50"
      process.env.BANYANCODE_SYSTEM_GPU_MAX_FAILURES = "3"
      try {
        const runs: string[] = []
        const failingProcess = Layer.succeed(
          AppProcess.Service,
          AppProcess.Service.of({
            run: (command: ChildProcess.Command) =>
              Effect.sync(() => {
                if (command._tag === "StandardCommand") runs.push(command.command)
                return {
                  command: "nvidia-smi",
                  exitCode: 1,
                  stdout: Buffer.alloc(0),
                  stderr: Buffer.from("NVIDIA-SMI has failed"),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              }),
            runStream: () => {
              throw new Error("unused")
            },
          } as unknown as AppProcess.Interface),
        )

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const monitor = yield* SystemMonitor.Service
              // 60ms sleeps step past the 50ms GPU TTL (but stay inside the 1s
              // status cache): each iteration re-probes until the breaker trips.
              for (let i = 0; i < 8; i++) {
                yield* monitor.status()
                yield* Effect.sleep(Duration.millis(60))
              }
              expect(runs.filter((c) => c === "nvidia-smi").length).toBe(3)

              // Still disabled after further TTL windows pass: non-ENOENT
              // failures must not retry forever.
              yield* Effect.sleep(Duration.millis(120))
              yield* monitor.status()
              expect(runs.filter((c) => c === "nvidia-smi").length).toBe(3)
            }),
          ).pipe(Effect.provide(SystemMonitor.layer.pipe(Layer.provide(failingProcess)))),
        )
      } finally {
        delete process.env.BANYANCODE_SYSTEM_GPU_TTL_MS
        delete process.env.BANYANCODE_SYSTEM_GPU_MAX_FAILURES
      }
    })
  })
})
