export * as SystemMonitor from "./system-monitor"

import { Context, Effect, Duration, Layer, Queue, Ref, Stream } from "effect"
import os from "node:os"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import * as Schema from "effect/Schema"
import { EventV2 } from "../event"
import * as Schedule from "effect/Schedule"

export interface SystemStatus {
  cpuPercent?: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  gpuPercent?: number
  vramUsedBytes?: number
  gpuTotalBytes?: number
  diskUsedBytes?: number
  diskTotalBytes?: number
  temperatureC?: number
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
    cpuPercent: Schema.optional(Schema.Number),
    memoryUsedBytes: Schema.Number,
    memoryTotalBytes: Schema.Number,
    gpuPercent: Schema.optional(Schema.Number),
    vramUsedBytes: Schema.optional(Schema.Number),
    gpuTotalBytes: Schema.optional(Schema.Number),
    diskUsedBytes: Schema.optional(Schema.Number),
    diskTotalBytes: Schema.optional(Schema.Number),
    temperatureC: Schema.optional(Schema.Number),
    platform: Schema.Literals(["windows", "linux", "darwin"]),
  },
})

const readDisk = (
  proc: AppProcess.Interface,
): Effect.Effect<{ diskUsedBytes?: number; diskTotalBytes?: number }, never, never> => {
  if (process.platform === "darwin") return Effect.succeed({})
  if (process.platform === "win32") {
    return Effect.flatMap(proc.run(
      ChildProcess.make(
        "wmic",
        ["logicaldisk", "where", "DeviceID='C:'", "get", "Size,FreeSpace", "/format:csv,noheader"],
        { extendEnv: true, stdin: "ignore" },
      ),
      { maxOutputBytes: 1024, maxErrorBytes: 256 },
    ), (result) => {
      if (result.exitCode !== 0) return Effect.succeed({})
      const cells = result.stdout.toString().trim().split(",")
      if (cells.length < 2) return Effect.succeed({})
      const freeSpace = Number(cells[0])
      const size = Number(cells[1])
      if (!Number.isFinite(freeSpace) || !Number.isFinite(size)) return Effect.succeed({})
      return Effect.succeed({ diskTotalBytes: size, diskUsedBytes: size - freeSpace })
    }).pipe(Effect.orDie)
  }
  return Effect.flatMap(proc.run(
    ChildProcess.make("df", ["-k", "/"], { extendEnv: true, stdin: "ignore" }),
    { maxOutputBytes: 1024, maxErrorBytes: 256 },
  ), (result) => {
    if (result.exitCode !== 0) return Effect.succeed({})
    const lines = result.stdout.toString().trim().split("\n")
    if (lines.length < 2) return Effect.succeed({})
    const cells = lines[1].split(/\s+/)
    if (cells.length < 3) return Effect.succeed({})
    const total = Number(cells[1]) * 1024
    const used = Number(cells[2]) * 1024
    if (!Number.isFinite(total) || !Number.isFinite(used)) return Effect.succeed({})
    return Effect.succeed({ diskTotalBytes: total, diskUsedBytes: used })
  }).pipe(Effect.orDie)
}

const readTemperature = (
  proc: AppProcess.Interface,
): Effect.Effect<{ temperatureC?: number }, never, never> => {
  if (process.platform === "darwin") return Effect.succeed({})
  if (process.platform === "win32") {
    return Effect.flatMap(proc.run(
      ChildProcess.make(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature | Measure-Object -Property CurrentTemperature -Maximum).Maximum",
        ],
        { extendEnv: true, stdin: "ignore" },
      ),
      { maxOutputBytes: 256, maxErrorBytes: 256 },
    ), (result) => {
      if (result.exitCode !== 0) return Effect.succeed({})
      const deciKelvin = Number(result.stdout.toString().trim())
      if (!Number.isFinite(deciKelvin) || deciKelvin <= 0) return Effect.succeed({})
      const celsius = deciKelvin / 10 - 273.15
      return Effect.succeed({ temperatureC: Math.round(celsius * 10) / 10 })
    }).pipe(Effect.orDie)
  }
  return Effect.flatMap(proc.run(
    ChildProcess.make(
      "sh",
      ["-c", "cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null"],
      { extendEnv: true, stdin: "ignore" },
    ),
    { maxOutputBytes: 256, maxErrorBytes: 256 },
  ), (result) => {
    if (result.exitCode !== 0) return Effect.succeed({})
    const temps: number[] = []
    for (const line of result.stdout.toString().split("\n")) {
      const milliC = Number(line.trim())
      if (Number.isFinite(milliC) && milliC > 0) temps.push(milliC)
    }
    if (temps.length === 0) return Effect.succeed({})
    const maxMilli = Math.max(...temps)
    return Effect.succeed({ temperatureC: Math.round(maxMilli / 10) / 100 })
  }).pipe(Effect.orDie)
}

const detectPlatform = (): "windows" | "linux" | "darwin" => {
  const p = process.platform
  if (p === "win32") return "windows"
  if (p === "darwin") return "darwin"
  return "linux"
}

const takeCpuSnapshot = (): Map<string, number> => {
  const cpus = os.cpus()
  const totals = new Map<string, number>()
  for (const cpu of cpus) {
    const total = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + (cpu.times.irq ?? 0)
    totals.set("total", (totals.get("total") ?? 0) + total)
    totals.set("idle", (totals.get("idle") ?? 0) + cpu.times.idle)
  }
  return totals
}

const computeCpuPercent = (prev: Map<string, number> | undefined, cur: Map<string, number>): number | undefined => {
  if (!prev) return undefined
  const totalDelta = (cur.get("total") ?? 0) - (prev.get("total") ?? 0)
  const idleDelta = (cur.get("idle") ?? 0) - (prev.get("idle") ?? 0)
  if (totalDelta <= 0) return undefined
  return (1 - idleDelta / totalDelta) * 100
}

interface CachedStatus {
  value: SystemStatus
  at: number
}

interface Cache {
  cached: CachedStatus | undefined
  gpu: { gpuPercent: number; vramUsedBytes: number; gpuTotalBytes: number } | undefined
  gpuAt: number
  diskAndTemp: { diskUsedBytes?: number; diskTotalBytes?: number; temperatureC?: number } | undefined
  diskAndTempAt: number
}

const GPU_CACHE_TTL_MS = 30_000
const DISK_TEMP_CACHE_TTL_MS = 5_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cache = yield* Ref.make<Cache>({ cached: undefined, gpu: undefined, gpuAt: 0, diskAndTemp: undefined, diskAndTempAt: 0 })
    const cpuPrev = yield* Ref.make<Map<string, number> | undefined>(undefined)
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

        let diskAndTemp: { diskUsedBytes?: number; diskTotalBytes?: number; temperatureC?: number } | undefined
        if (snapshot.diskAndTemp && now - snapshot.diskAndTempAt < DISK_TEMP_CACHE_TTL_MS) {
          diskAndTemp = snapshot.diskAndTemp
        } else {
          const disk = yield* readDisk(proc as AppProcess.Interface)
          const temp = yield* readTemperature(proc as AppProcess.Interface)
          if (Object.keys(disk).length > 0 || Object.keys(temp).length > 0) {
            diskAndTemp = { ...disk, ...temp }
          }
        }

        if (snapshot.cached && now - snapshot.cached.at < 1000) {
          return {
            ...snapshot.cached.value,
            ...(gpu
              ? { gpuPercent: gpu.gpuPercent, vramUsedBytes: gpu.vramUsedBytes, gpuTotalBytes: gpu.gpuTotalBytes }
              : {}),
            ...(diskAndTemp
              ? { diskUsedBytes: diskAndTemp.diskUsedBytes, diskTotalBytes: diskAndTemp.diskTotalBytes, temperatureC: diskAndTemp.temperatureC }
              : {}),
          }
        }

        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const platform = detectPlatform()

        const prev = yield* Ref.get(cpuPrev)
        const cur = takeCpuSnapshot()
        const cpuPercent = computeCpuPercent(prev, cur)
        yield* Ref.set(cpuPrev, cur)

        const value: SystemStatus = {
          cpuPercent,
          memoryUsedBytes: totalMem - freeMem,
          memoryTotalBytes: totalMem,
          platform,
          ...(gpu
            ? { gpuPercent: gpu.gpuPercent, vramUsedBytes: gpu.vramUsedBytes, gpuTotalBytes: gpu.gpuTotalBytes }
            : {}),
          ...(diskAndTemp
            ? { diskUsedBytes: diskAndTemp.diskUsedBytes, diskTotalBytes: diskAndTemp.diskTotalBytes, temperatureC: diskAndTemp.temperatureC }
            : {}),
        }

        yield* Ref.set(cache, { cached: { value, at: now }, gpu, gpuAt: now, diskAndTemp, diskAndTempAt: now })
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