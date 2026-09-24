export * as SystemMonitor from "./system-monitor"

import { Cause, Context, Effect, Duration, Layer, Queue, Ref, Stream } from "effect"
import fs from "node:fs"
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
    platform: Schema.Literals(["windows", "linux", "darwin"]),
  },
})

const defaultDiskPath = (): string =>
  process.platform === "win32" ? process.cwd() : "/"

export const readDisk = (
  path: string = defaultDiskPath(),
): Effect.Effect<{ diskUsedBytes?: number; diskTotalBytes?: number }, never, never> =>
  Effect.gen(function* () {
    const stats = yield* Effect.tryPromise({
      try: () => fs.promises.statfs(path),
      catch: () => new Error("statfs failed"),
    }).pipe(Effect.catch(() => Effect.succeed(undefined as fs.StatsFs | undefined)))
    if (!stats) return {}
    const { bsize, blocks, bavail } = stats
    if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || !Number.isFinite(bavail)) return {}
    if (bsize <= 0 || blocks <= 0 || bavail < 0) return {}
    const total = bsize * blocks
    const used = total - bsize * bavail
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0 || used < 0) return {}
    return { diskTotalBytes: total, diskUsedBytes: used }
  })

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

/** True when a spawn failed because the binary is missing (ENOENT / NotFound). */
const isCommandNotFound = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false
  const e = error as {
    code?: string
    _tag?: string
    reason?: unknown
    cause?: unknown
    error?: unknown
  }
  if (e.code === "ENOENT") return true
  if (e._tag === "SystemError" && e.reason === "NotFound") return true
  if (e.cause !== undefined && isCommandNotFound(e.cause)) return true
  if (e.error !== undefined && isCommandNotFound(e.error)) return true
  return false
}

interface CachedStatus {
  value: SystemStatus
  at: number
}

interface Cache {
  cached: CachedStatus | undefined
  gpu: { gpuPercent: number; vramUsedBytes: number; gpuTotalBytes: number } | undefined
  gpuAt: number
  disk: { diskUsedBytes?: number; diskTotalBytes?: number } | undefined
  diskAt: number
}

const GPU_CACHE_TTL_MS = 30_000
const DISK_CACHE_TTL_MS = 5_000
const STATUS_CACHE_TTL_MS = 1_000
const TICK_MS = 1_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cache = yield* Ref.make<Cache>({ cached: undefined, gpu: undefined, gpuAt: 0, disk: undefined, diskAt: 0 })
    const cpuPrev = yield* Ref.make<Map<string, number> | undefined>(undefined)
    // After the first nvidia-smi ENOENT, skip GPU probes for the rest of this layer's lifetime.
    const gpuDisabled = yield* Ref.make(false)
    const proc = yield* AppProcess.Service

    const status: Interface["status"] = () =>
      Effect.gen(function* () {
        const now = Date.now()
        const snapshot = yield* Ref.get(cache)

        let gpu = snapshot.gpu
        let gpuAt = snapshot.gpuAt
        const gpuCacheHit = snapshot.gpuAt > 0 && now - snapshot.gpuAt < GPU_CACHE_TTL_MS
        if (!gpuCacheHit) {
          gpu = undefined
          gpuAt = now
          const disabled = yield* Ref.get(gpuDisabled)
          if (!disabled && process.platform !== "darwin") {
            const outcome = yield* proc
              .run(
                ChildProcess.make(
                  "nvidia-smi",
                  ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
                  { extendEnv: true, stdin: "ignore" },
                ),
                { maxOutputBytes: 1024, maxErrorBytes: 256, timeout: "2 seconds" },
              )
              .pipe(
                Effect.map((result) => ({ tag: "ran" as const, result })),
                Effect.catchCause((cause) =>
                  Effect.succeed(
                    isCommandNotFound(Cause.squash(cause))
                      ? ({ tag: "enoent" as const })
                      : ({ tag: "failed" as const }),
                  ),
                ),
              )
            if (outcome.tag === "enoent") {
              yield* Ref.set(gpuDisabled, true)
            } else if (outcome.tag === "ran" && outcome.result.exitCode === 0) {
              const line = outcome.result.stdout.toString().trim().split("\n")[0]
              if (line) {
                const parts = line.split(",").map((s: string) => Number(s.trim()))
                if (parts.length >= 3 && parts.every(Number.isFinite)) {
                  gpu = {
                    gpuPercent: parts[0],
                    vramUsedBytes: parts[1] * 1024 * 1024,
                    gpuTotalBytes: parts[2] * 1024 * 1024,
                  }
                }
              }
            }
          }
        }

        let disk = snapshot.disk
        let diskAt = snapshot.diskAt
        const diskCacheHit = snapshot.diskAt > 0 && now - snapshot.diskAt < DISK_CACHE_TTL_MS
        if (!diskCacheHit) {
          disk = undefined
          diskAt = now
          const result = yield* readDisk()
          if (Object.keys(result).length > 0) {
            disk = result
          }
        }

        if (snapshot.cached && now - snapshot.cached.at < STATUS_CACHE_TTL_MS) {
          // Persist refreshed disk/gpu cache entries (including failures) on the
          // warm early-return path so the next spin does not re-probe.
          if (!gpuCacheHit || !diskCacheHit) {
            yield* Ref.set(cache, { ...snapshot, gpu, gpuAt, disk, diskAt })
          }
          return {
            ...snapshot.cached.value,
            ...(gpu
              ? { gpuPercent: gpu.gpuPercent, vramUsedBytes: gpu.vramUsedBytes, gpuTotalBytes: gpu.gpuTotalBytes }
              : {}),
            ...(disk
              ? { diskUsedBytes: disk.diskUsedBytes, diskTotalBytes: disk.diskTotalBytes }
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
          ...(disk
            ? { diskUsedBytes: disk.diskUsedBytes, diskTotalBytes: disk.diskTotalBytes }
            : {}),
        }

        yield* Ref.set(cache, { cached: { value, at: now }, gpu, gpuAt, disk, diskAt })
        return value
      })

    const tick = (q: Queue.Queue<SystemStatus>) =>
      Effect.gen(function* () {
        const s = yield* status()
        yield* Queue.offer(q, s)
      })

    const queue = yield* Queue.bounded<SystemStatus>(60)
    yield* Effect.addFinalizer(() => Queue.shutdown(queue))
    // The producer tick. `Effect.forever` never completes, so wrapping it in
    // `Schedule.spaced` did nothing — iterations ran back-to-back and
    // busy-spun the sampler. Use `repeat(spaced)` on the per-tick effect so
    // the schedule actually paces iterations.
    yield* Effect.forkScoped(
      tick(queue).pipe(Effect.repeat(Schedule.spaced(Duration.millis(TICK_MS)))),
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
)

export const defaultLayer = layer.pipe(Layer.provide(AppProcess.defaultLayer))
