export * as SystemMonitor from "./system-monitor"

import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs"
import os from "os"

export interface SystemStatus {
  cpuPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  gpuPercent?: number
  vramUsedBytes?: number
  platform: "windows" | "linux" | "darwin"
}

export interface Interface {
  readonly status: () => Effect.Effect<SystemStatus, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/SystemMonitor") {}

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

export const layer = Layer.succeed(
  Service,
  Service.of({
    status: Effect.fn("SystemMonitor.status")(function* () {
      const total = os.totalmem()
      const free = os.freemem()
      const platform = detectPlatform()
      const cpu = yield* sampleCPU()

      return {
        cpuPercent: cpu,
        memoryUsedBytes: total - free,
        memoryTotalBytes: total,
        platform,
      }
    }),
  }),
)

export const defaultLayer = layer
