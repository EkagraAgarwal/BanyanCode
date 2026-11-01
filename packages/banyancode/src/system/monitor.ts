import { execFile } from "node:child_process"
import { statfs } from "node:fs/promises"
import os from "node:os"

/**
 * Host health sampler, ported from v1
 * `packages/core/src/banyancode/system-monitor.ts`.
 *
 * v2 has no host `SystemMonitor` service, so the plugin owns the sampler:
 * CPU is a delta between two `os.cpus()` snapshots, GPU comes from
 * `nvidia-smi` when available (30s cache), disk from `statfs` (5s cache) and
 * the whole status is cached for a second so a TUI panel refresh does not
 * hammer the machine. Every probe is best-effort: a missing GPU or an
 * unsupported `statfs` simply omits the field.
 */

export type Platform = "windows" | "linux" | "darwin"

export interface SystemStatus {
  readonly cpuPercent?: number
  readonly memoryUsedBytes: number
  readonly memoryTotalBytes: number
  readonly gpuPercent?: number
  readonly vramUsedBytes?: number
  readonly gpuTotalBytes?: number
  readonly diskUsedBytes?: number
  readonly diskTotalBytes?: number
  readonly platform: Platform
}

interface GpuStatus {
  readonly gpuPercent: number
  readonly vramUsedBytes: number
  readonly gpuTotalBytes: number
}

interface CpuSnapshot {
  readonly total: number
  readonly idle: number
}

const GPU_CACHE_TTL_MS = 30_000
const DISK_CACHE_TTL_MS = 5_000
const STATUS_CACHE_TTL_MS = 1_000

export const detectPlatform = (platform: NodeJS.Platform = process.platform): Platform => {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "darwin"
  return "linux"
}

const cpuSnapshot = (): CpuSnapshot => {
  let total = 0
  let idle = 0
  for (const cpu of os.cpus()) {
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + (cpu.times.irq ?? 0)
    idle += cpu.times.idle
  }
  return { total, idle }
}

export const cpuPercent = (previous: CpuSnapshot | undefined, current: CpuSnapshot): number | undefined => {
  if (previous === undefined) return undefined
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (total <= 0) return undefined
  return (1 - idle / total) * 100
}

const execFileAsync = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 1_500, windowsHide: true, maxBuffer: 4096 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(String(stdout))
    })
  })

export const parseNvidiaSmi = (stdout: string): GpuStatus | undefined => {
  const line = stdout.trim().split(/\r?\n/)[0]
  if (line === undefined || line.length === 0) return undefined
  const parts = line.split(",").map((part) => Number(part.trim()))
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return undefined
  return {
    gpuPercent: parts[0]!,
    vramUsedBytes: parts[1]! * 1024 * 1024,
    gpuTotalBytes: parts[2]! * 1024 * 1024,
  }
}

const probeGpu = async (): Promise<GpuStatus | undefined> => {
  if (process.platform === "darwin") return undefined
  try {
    const stdout = await execFileAsync("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ])
    return parseNvidiaSmi(stdout)
  } catch {
    return undefined
  }
}

export const readDisk = async (
  path: string = process.platform === "win32" ? process.cwd() : "/",
): Promise<{ diskUsedBytes?: number; diskTotalBytes?: number }> => {
  try {
    const stats = await statfs(path)
    const total = stats.bsize * stats.blocks
    const free = stats.bsize * stats.bavail
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return {}
    const used = total - free
    if (used < 0) return {}
    return { diskTotalBytes: total, diskUsedBytes: used }
  } catch {
    return {}
  }
}

export interface SystemMonitorOptions {
  /** Disable the `nvidia-smi` probe (tests, CI, darwin). */
  readonly gpu?: boolean
  readonly disk?: boolean
  readonly diskPath?: string
  readonly now?: () => number
}

export interface SystemMonitor {
  readonly status: () => Promise<SystemStatus>
}

export const createSystemMonitor = (options: SystemMonitorOptions = {}): SystemMonitor => {
  const now = options.now ?? Date.now
  let previousCpu: CpuSnapshot | undefined
  let cachedStatus: { at: number; value: SystemStatus } | undefined
  let cachedGpu: { at: number; value: GpuStatus | undefined } | undefined
  let cachedDisk: { at: number; value: { diskUsedBytes?: number; diskTotalBytes?: number } | undefined } | undefined

  const gpu = async (): Promise<GpuStatus | undefined> => {
    if (options.gpu === false) return undefined
    const at = now()
    if (cachedGpu !== undefined && at - cachedGpu.at < GPU_CACHE_TTL_MS) return cachedGpu.value
    const value = await probeGpu()
    cachedGpu = { at, value }
    return value
  }

  const disk = async (): Promise<{ diskUsedBytes?: number; diskTotalBytes?: number } | undefined> => {
    if (options.disk === false) return undefined
    const at = now()
    if (cachedDisk !== undefined && at - cachedDisk.at < DISK_CACHE_TTL_MS) return cachedDisk.value
    const value = await readDisk(options.diskPath)
    cachedDisk = { at, value: Object.keys(value).length > 0 ? value : undefined }
    return cachedDisk.value
  }

  const status = async (): Promise<SystemStatus> => {
    const at = now()
    if (cachedStatus !== undefined && at - cachedStatus.at < STATUS_CACHE_TTL_MS) return cachedStatus.value
    const [gpuStatus, diskStatus] = await Promise.all([gpu(), disk()])
    const current = cpuSnapshot()
    const cpu = cpuPercent(previousCpu, current)
    previousCpu = current
    const totalMemory = os.totalmem()
    const freeMemory = os.freemem()
    const value: SystemStatus = {
      ...(cpu === undefined ? {} : { cpuPercent: cpu }),
      memoryUsedBytes: totalMemory - freeMemory,
      memoryTotalBytes: totalMemory,
      platform: detectPlatform(),
      ...(gpuStatus === undefined
        ? {}
        : {
            gpuPercent: gpuStatus.gpuPercent,
            vramUsedBytes: gpuStatus.vramUsedBytes,
            gpuTotalBytes: gpuStatus.gpuTotalBytes,
          }),
      ...(diskStatus === undefined ? {} : diskStatus),
    }
    cachedStatus = { at, value }
    return value
  }

  return { status }
}

/** One-shot status for callers that do not need the cache/delta state. */
export const readSystemStatus = async (options: SystemMonitorOptions = {}): Promise<SystemStatus> => {
  const monitor = createSystemMonitor(options)
  // Prime the CPU baseline so a one-shot call still reports CPU when allowed.
  await monitor.status()
  return monitor.status()
}

export const formatBytesMb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(0)
export const formatBytesGb = (bytes: number): string => (bytes / 1024 / 1024 / 1024).toFixed(1)
