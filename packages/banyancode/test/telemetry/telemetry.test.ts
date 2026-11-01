import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Telemetry from "../../src/telemetry/telemetry.js"
import { callHook, configFor, makeContext, withStorage, withTemp } from "../gateway/harness.js"

const setup = async (directory: string, values: Record<string, unknown> = {}) => {
  const config = await configFor(directory, values)
  const harness = makeContext(directory)
  await withStorage(directory, (storage) =>
    Telemetry.register(harness.ctx, { storage, config }),
  ).pipe(Effect.runPromise)
  return harness
}

const afterEvent = (status: "completed" | "error", tool = "read", id = "call-1") => ({
  tool,
  sessionID: "ses_a",
  agent: "build",
  messageID: "msg_1",
  id,
  input: { path: "src/a.ts" },
  ...(status === "completed"
    ? { status, result: { content: "ok" } }
    : { status, error: { message: "boom" } }),
})

describe("telemetry register", () => {
  test("completed tools write usage rows; errors do not", async () => {
    await withTemp(async (directory) => {
      const config = await configFor(directory, { banyancode_agent_telemetry_max_events: 2 })
      const harness = makeContext(directory)
      const result = await withStorage(directory, (storage) =>
        Effect.gen(function* () {
          yield* Telemetry.register(harness.ctx, { storage, config })
          yield* callHook(harness.tool.get("execute.after"), afterEvent("completed")).pipe(Effect.orDie)
          yield* callHook(harness.tool.get("execute.after"), afterEvent("completed", "read", "call-2")).pipe(Effect.orDie)
          yield* callHook(harness.tool.get("execute.after"), afterEvent("error", "grep", "call-3")).pipe(Effect.orDie)
          const rpc = harness.rpcs.find((entry) => entry.definition.id === "banyancode.usage")
          if (rpc === undefined) return { tools: [] as { toolId: string; useCount: number }[] }
          return (yield* rpc.handlers.toolUsage!({ session: "ses_a" }, {}).pipe(Effect.orDie)) as {
            tools: { toolId: string; useCount: number }[]
          }
        }),
      ).pipe(Effect.runPromise)

      expect(result.tools).toEqual([expect.objectContaining({ toolId: "read", useCount: 2 })])
    })
  })

  test("tokenUsage RPC returns the attributed ring", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory)
      const rpc = harness.rpcs.find((entry) => entry.definition.id === "banyancode.usage")
      expect(rpc).toBeDefined()
      const result = await Effect.runPromise(rpc!.handlers.tokenUsage!({}, {})) as { events: unknown[] }
      expect(result.events).toEqual([])
    })
  })

  test("the usage RPC is registered with the v1 tool-usage shape", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory)
      const rpc = harness.rpcs.find((entry) => entry.definition.id === "banyancode.usage")
      expect(Object.keys(rpc!.handlers).sort()).toEqual(["tokenUsage", "toolUsage"])
    })
  })
})
