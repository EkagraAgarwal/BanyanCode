import { describe, expect, test } from "bun:test"
import { cpuPercent, createSystemMonitor, detectPlatform, parseNvidiaSmi } from "../../src/system/monitor.js"
import { lspStatus, resolveIdleTimeoutMs, DEFAULT_LSP_IDLE_TIMEOUT_MS } from "../../src/system/lsp.js"
import type { Info } from "../../src/config/schema.js"

describe("system monitor", () => {
  test("CPU percentage is derived from snapshot deltas", () => {
    expect(cpuPercent(undefined, { total: 100, idle: 50 })).toBeUndefined()
    expect(cpuPercent({ total: 0, idle: 0 }, { total: 100, idle: 25 })).toBe(75)
    expect(cpuPercent({ total: 100, idle: 100 }, { total: 100, idle: 100 })).toBeUndefined()
  })

  test("nvidia-smi parsing handles valid and noise output", () => {
    expect(parseNvidiaSmi("42, 1024, 8192\n")).toEqual({
      gpuPercent: 42,
      vramUsedBytes: 1024 * 1024 * 1024,
      gpuTotalBytes: 8192 * 1024 * 1024,
    })
    expect(parseNvidiaSmi("")).toBeUndefined()
    expect(parseNvidiaSmi("not,a,number")).toBeUndefined()
  })

  test("status reports real memory and platform without GPU/disk probes", async () => {
    let now = 1_000
    const monitor = createSystemMonitor({ gpu: false, disk: false, now: () => now })
    const first = await monitor.status()
    expect(first.memoryUsedBytes).toBeGreaterThan(0)
    expect(first.memoryTotalBytes).toBeGreaterThanOrEqual(first.memoryUsedBytes)
    expect(first.platform).toBe(detectPlatform())
    expect(first.cpuPercent).toBeUndefined()
    expect(first.gpuPercent).toBeUndefined()
    expect(first.diskUsedBytes).toBeUndefined()
    now += 1_500
    const second = await monitor.status()
    expect(second.memoryTotalBytes).toBe(first.memoryTotalBytes)
  })

  test("status caches within a second", async () => {
    const monitor = createSystemMonitor({ gpu: false, disk: false, now: () => 5_000 })
    const first = await monitor.status()
    const second = await monitor.status()
    expect(second).toBe(first)
  })
})

describe("LSP config status", () => {
  test("boolean and object forms map to the TUI status shape", () => {
    expect(lspStatus({} as Info)).toMatchObject({ enabled: false, servers: [] })
    expect(lspStatus({ banyancode_lsp: true } as Info)).toMatchObject({ enabled: true, servers: [] })
    const status = lspStatus({
      banyancode_lsp: {
        typescript: { extensions: [".ts", ".tsx"] },
        rust: { disabled: true },
      },
      banyancode_lsp_idle_timeout_ms: 120_000,
    } as Info)
    expect(status.enabled).toBe(true)
    expect(status.idleTimeoutMs).toBe(120_000)
    expect(status.servers).toEqual([
      {
        id: "typescript",
        status: "configured",
        languages: [".ts", ".tsx"],
        inert: true,
        disabled: false,
        disabledReason: "LSP runtime is not active in this session",
      },
      {
        id: "rust",
        status: "configured",
        languages: [],
        inert: true,
        disabled: true,
        disabledReason: "Disabled by banyancode_lsp",
      },
    ])
  })

  test("idle timeout defaults to five minutes and ignores invalid values", () => {
    expect(resolveIdleTimeoutMs(undefined)).toBe(DEFAULT_LSP_IDLE_TIMEOUT_MS)
    expect(resolveIdleTimeoutMs(0)).toBe(0)
    expect(resolveIdleTimeoutMs(-1)).toBe(DEFAULT_LSP_IDLE_TIMEOUT_MS)
    expect(resolveIdleTimeoutMs("1000")).toBe(DEFAULT_LSP_IDLE_TIMEOUT_MS)
    expect(resolveIdleTimeoutMs(1234.9)).toBe(1234)
  })
})
