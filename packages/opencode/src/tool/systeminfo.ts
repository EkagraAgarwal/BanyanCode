import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import { Banyan } from "@opencode-ai/core/banyancode"
import DESCRIPTION from "./systeminfo.txt"

const Parameters = Schema.Struct({})

export const SysteminfoTool = Tool.define(
  "systeminfo",
  Effect.gen(function* () {
    const monitorOpt = yield* Effect.serviceOption(Banyan.SystemMonitorService)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => {
        return Effect.gen(function* () {
          if (Option.isNone(monitorOpt)) {
            return {
              title: "System Info",
              output: "System monitor is not available",
              metadata: {} as object,
            }
          }
          const status = yield* monitorOpt.value.status()
          console.error(`[turso.system] tool called agent=${ctx.agent}`)

          const memUsedGB = (status.memoryUsedBytes / 1024 / 1024 / 1024).toFixed(1)
          const memTotalGB = (status.memoryTotalBytes / 1024 / 1024 / 1024).toFixed(1)
          const gpuLine = status.gpuPercent !== undefined
            ? `GPU: ${status.gpuPercent}% | VRAM: ${(status.vramUsedBytes! / 1024 / 1024 / 1024).toFixed(1)}/${(status.gpuTotalBytes! / 1024 / 1024 / 1024).toFixed(1)} GB`
            : "GPU: N/A"

          const output = [
            `Platform: ${status.platform}`,
            `CPU: ${status.cpuPercent.toFixed(1)}%`,
            `Memory: ${memUsedGB} / ${memTotalGB} GB`,
            gpuLine,
          ].join("\n")

          return {
            title: "System Info",
            output,
            metadata: {} as object,
          }
        }).pipe(Effect.orDie)
      },
    }
  }),
)
