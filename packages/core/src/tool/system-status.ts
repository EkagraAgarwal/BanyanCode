export * as SystemStatusTool from "./system-status"

import { Effect, Layer, Schema } from "effect"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Banyan } from "../banyancode"

export const name = "system_status"

export const Input = Schema.Struct({})
export const Output = Schema.Struct({
  cpuPercent: Schema.Number,
  memoryUsedBytes: Schema.Number,
  memoryTotalBytes: Schema.Number,
  gpuPercent: Schema.optional(Schema.Number),
  vramUsedBytes: Schema.optional(Schema.Number),
  platform: Schema.Literals(["windows", "linux", "darwin"]),
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const monitor = yield* Banyan.SystemMonitor

    yield* tools
      .register({
        [name]: Tool.make({
          description: "Get current system health: CPU usage, memory used/total, GPU usage (if available), and platform.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `CPU: ${output.cpuPercent.toFixed(1)}%, Memory: ${(output.memoryUsedBytes / 1024 / 1024).toFixed(0)}MB / ${(output.memoryTotalBytes / 1024 / 1024).toFixed(0)}MB, Platform: ${output.platform}`,
            },
          ],
          execute: (_input, _context) =>
            Effect.gen(function* () {
              const status = yield* monitor.status()
              return status
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
