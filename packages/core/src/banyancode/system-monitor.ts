export * as SystemMonitor from "./system-monitor"

import { Context, Effect, Duration, Layer, Queue, Ref, Stream } from "effect"
import * as fs from "node:fs"
import os from "node:os"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import * as Schema from "effect/Schema"
import { EventV2 } from "../event"
import * as Schedule from "effect/Schedule"

export interface SystemStatus {
  cpuPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  gpuPercent?: number
  vramUsedBytes?: number
  gpuTotalBytes?: number
  platform: "windows" | "linux" | "darwin"
}

export interface Interface {
  readonly status: () => Effect.Effect<SystemStatus, never, never>
  readonly watch: (intervalMs?: number) => Effect.Effect<Stream.Stream<SystemStatus>, never, never>
  readonly events: () => Effect.Effect<Queue.Dequeue<SystemStatus>, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SystemMonitor") {}

export const Updated = EventV2.define({
  type: "banyancode.system.updated",
  schema: {
    cpuPercent: Schema.Number,
    memoryUsedBytes: Schema.Number,
    memoryTotalBytes: Schema.Number,
    gpuPercent: Schema.optional(Schema.Number),
    vramUsedBytes: Schema.optional(Schema.Number),
    gpuTotalBytes: Schema.optional(Schema.Number),
    platform: Schema.Literals(["windows", "linux", "darwin"]),
  },
})

const detectPlatform = (): "windows" | "linux" | "darwin" => {
  const p = process.platform
  if (p === "win32") return "windows"
  if (p === "darwin") return "darwin"
  return "linux"
}

const readLinuxCPU = Effect.fn("SystemMonitor.readLinuxCPU")(function* () {
  const stat = yield* Effect.try({
    try: () => fs.readFileSync("/proc/stat", "utf-8"),
    catch: () => "",
  })
  const line = stat.split("\n").find((l) => l.startsWith("cpu "))
  if (!line) return 0
  const parts = line.split(/\s+/)
  const user = Number(parts[1])
  const nice = Number(parts[2])
  const system = Number(parts[3])
  const idle = Number(parts[4])
  const iowait = Number(parts[5]) || 0
  const irq = Number(parts[6]) || 0
  const softirq = Number(parts[7]) || 0
  const total = user + nice + system + idle + iowait + irq + softirq
  if (total === 0) return 0
  return ((total - idle - iowait) / total) * 100
})

const sampleCPU = (): Effect.Effect<number, never, never> => {
  const p = process.platform
  if (p === "linux") return readLinuxCPU().pipe(Effect.catch(() => Effect.succeed(0)))
  return Effect.succeed(0)
}

interface CachedStatus {
  value: SystemStatus
  at: number
}

interface Cache {
  cached: CachedStatus | undefined
  gpu: { gpuPercent: number; vramUsedBytes: number; gpuTotalBytes: number } | undefined
  gpuAt: number
}

const GPU_CACHE_TTL_MS = 30_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cache = yield* Ref.make<Cache>({ cached: undefined, gpu: undefined, gpuAt: 0 })
    const proc = yield* AppProcess.Service

    const status: Interface["status"] = () =>
      Effect.gen(function* () {
        const now = Date.now()
        const snapshot = yield* Ref.get(cache)

        let gpu: { gpuPercent: number; vramUsedBytes: number; gpuTotalBytes: number } | undefined
        if (snapshot.gpu && now - snapshot.gpuAt < GPU_CACHE_TTL_MS) {
          gpu = snapshot.gpu
        } else if (process.platform !== "darwin") {
          const runResult = yield* Effect.orDie(
            proc.run(
              ChildProcess.make(
                "nvidia-smi",
                ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
                { extendEnv: true, stdin: "ignore" },
              ),
              { maxOutputBytes: 1024, maxErrorBytes: 256 },
            ),
          ).pipe(Effect.catch(() => Effect.succeed({ exitCode: -1, stdout: { toString: () => "" } } as const)))
          if (runResult.exitCode === 0) {
            const text = runResult.stdout.toString()
            const line = text.trim().split("\n")[0]
            if (line) {
              const parts = line.split(",").map((s: string) => Number(s.trim()))
              if (parts.length >= 3 && parts.every(Number.isFinite)) {
                gpu = { gpuPercent: parts[0], vramUsedBytes: parts[1] * 1024 * 1024, gpuTotalBytes: parts[2] * 1024 * 1024 }
              }
            }
          }
        }

        if (snapshot.cached && now - snapshot.cached.at < 1000) {
          return {
            ...snapshot.cached.value,
            ...(gpu
              ? { gpuPercent: gpu.gpuPercent, vramUsedBytes: gpu.vramUsedBytes, gpuTotalBytes: gpu.gpuTotalBytes }
              : {}),
          }
        }

        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const platform = detectPlatform()
        const cpu = yield* sampleCPU()

        const value: SystemStatus = {
          cpuPercent: cpu,
          memoryUsedBytes: totalMem - freeMem,
          memoryTotalBytes: totalMem,
          platform,
          ...(gpu
            ? { gpuPercent: gpu.gpuPercent, vramUsedBytes: gpu.vramUsedBytes, gpuTotalBytes: gpu.gpuTotalBytes }
            : {}),
        }

        yield* Ref.set(cache, { cached: { value, at: now }, gpu, gpuAt: now })
        return value
      })

    const tick = (q: Queue.Queue<SystemStatus>) =>
      Effect.gen(function* () {
        const s = yield* status()
        yield* Queue.offer(q, s)
      })

    const queue = yield* Queue.bounded<SystemStatus>(60)
    yield* Effect.addFinalizer(() => Queue.shutdown(queue))
    yield* Effect.forkScoped(
      Effect.forever(tick(queue)).pipe(Effect.schedule(Schedule.spaced(Duration.millis(100)))),
    )

    const events = (): Effect.Effect<Queue.Dequeue<SystemStatus>, never, never> => Effect.succeed(queue)

    const watch: Interface["watch"] = (intervalMs = 1000) =>
      Effect.succeed(
        Stream.fromQueue(queue).pipe(
          Stream.throttle({
            cost: () => 1,
            units: 1,
            duration: Duration.millis(intervalMs),
            strategy: "shape",
          }),
        ),
      )

    return Service.of({ status, watch, events })
  }),
).pipe(Layer.provide(AppProcess.defaultLayer))

export const defaultLayer = layer