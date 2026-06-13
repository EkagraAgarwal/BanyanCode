import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SystemMonitor } from "../../../core/src/banyancode/system-monitor"
import { ToolRegistry } from "../../../core/src/tool/registry"
import { SystemStatusTool } from "../../../core/src/tool/system-status"
import { testEffect } from "../lib/effect"

const registry = ToolRegistry.defaultLayer
const toolLayer = Layer.mergeAll(SystemStatusTool.layer).pipe(
  Layer.provide(registry),
  Layer.provide(SystemMonitor.defaultLayer),
)

const it = testEffect(Layer.mergeAll(registry, toolLayer, SystemMonitor.defaultLayer))

const makeCtx = (sessionID = "test-session") => ({
  sessionID: sessionID as any,
  messageID: "msg-1" as any,
  agent: "test" as any,
  assistantMessageID: "am-1" as any,
  toolCallID: "tc-1",
  abort: new AbortController().signal,
  messages: [] as any[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("system_status tool", () => {
  it.effect("returns expected shape from SystemMonitor.status()", () =>
    Effect.gen(function* () {
      const reg = yield* ToolRegistry.Service
      const mat = yield* reg.materialize()
      const ctx = makeCtx()

      const result = yield* mat.settle({
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        assistantMessageID: ctx.assistantMessageID,
        call: {
          type: "tool-call",
          id: "call-1",
          name: "system_status",
          input: {},
        },
      })

      const output = result.output?.structured as any
      expect(typeof output.cpuPercent).toBe("number")
      expect(typeof output.memoryUsedBytes).toBe("number")
      expect(typeof output.memoryTotalBytes).toBe("number")
      expect(output.platform).toMatch(/^(windows|linux|darwin)$/)
    }),
  )

  it.effect("platform detection returns valid platform", () =>
    Effect.gen(function* () {
      const monitor = yield* SystemMonitor.Service
      const status = yield* monitor.status()
      expect(status.platform).toMatch(/^(windows|linux|darwin)$/)
    }),
  )

  it.effect("memory values are positive numbers", () =>
    Effect.gen(function* () {
      const monitor = yield* SystemMonitor.Service
      const status = yield* monitor.status()
      expect(status.memoryUsedBytes).toBeGreaterThan(0)
      expect(status.memoryTotalBytes).toBeGreaterThan(0)
      expect(status.memoryUsedBytes).toBeLessThanOrEqual(status.memoryTotalBytes)
    }),
  )

  it.effect("cpuPercent is between 0 and 100", () =>
    Effect.gen(function* () {
      const monitor = yield* SystemMonitor.Service
      const status = yield* monitor.status()
      expect(status.cpuPercent).toBeGreaterThanOrEqual(0)
      expect(status.cpuPercent).toBeLessThanOrEqual(100)
    }),
  )
})
