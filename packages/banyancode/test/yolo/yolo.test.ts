import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Yolo from "../../src/yolo/yolo.js"
import { callHook, configFor, makeContext, withTemp } from "../gateway/harness.js"

const setup = async (directory: string, values: Record<string, unknown>) => {
  const config = await configFor(directory, values)
  const harness = makeContext(directory)
  await Effect.runPromise(Effect.scoped(Yolo.register(harness.ctx, { config })))
  return harness
}

const evaluate = (effect: "allow" | "deny" | "ask") => ({
  sessionID: "ses_a",
  agent: "build",
  action: "shell",
  resources: ["rm -rf build"],
  effect,
})

describe("yolo permission hook", () => {
  test("config yolo mode auto-allows every request", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, { banyancode_yolo_mode: true })
      const ask = evaluate("ask")
      await Effect.runPromise(callHook(harness.permission.get("evaluate"), ask))
      expect(ask.effect).toBe("allow")
      const deny = evaluate("deny")
      await Effect.runPromise(callHook(harness.permission.get("evaluate"), deny))
      expect(deny.effect).toBe("allow")
    })
  })

  test("without yolo the evaluated effect is untouched", async () => {
    await withTemp(async (directory) => {
      const harness = await setup(directory, {})
      const ask = evaluate("ask")
      await Effect.runPromise(callHook(harness.permission.get("evaluate"), ask))
      expect(ask.effect).toBe("ask")
      // A configured deny reaches the hook; only yolo mode may override it.
      const deny = evaluate("deny")
      await Effect.runPromise(callHook(harness.permission.get("evaluate"), deny))
      expect(deny.effect).toBe("deny")
    })
  })

  test("BANYANCODE_YOLO_MODE enables yolo independently of config", async () => {
    await withTemp(async (directory) => {
      const previous = process.env.BANYANCODE_YOLO_MODE
      process.env.BANYANCODE_YOLO_MODE = "true"
      try {
        const harness = await setup(directory, { banyancode_yolo_mode: false })
        const ask = evaluate("ask")
        await Effect.runPromise(callHook(harness.permission.get("evaluate"), ask))
        expect(ask.effect).toBe("allow")
      } finally {
        if (previous === undefined) delete process.env.BANYANCODE_YOLO_MODE
        else process.env.BANYANCODE_YOLO_MODE = previous
      }
    })
  })

  test("config is re-read on every evaluation", async () => {
    await withTemp(async (directory) => {
      const config = await configFor(directory, {})
      const harness = makeContext(directory)
      await Effect.runPromise(Effect.scoped(Yolo.register(harness.ctx, { config })))

      const first = evaluate("ask")
      await Effect.runPromise(callHook(harness.permission.get("evaluate"), first))
      expect(first.effect).toBe("ask")

      await Bun.write(`${directory}/banyancode.json`, JSON.stringify({ banyancode_yolo_mode: true }))
      const second = evaluate("ask")
      await Effect.runPromise(callHook(harness.permission.get("evaluate"), second))
      expect(second.effect).toBe("allow")
    })
  })

  test("env parser accepts the documented truthy spellings", () => {
    expect(Yolo.envYoloEnabled({ BANYANCODE_YOLO_MODE: "1" })).toBe(true)
    expect(Yolo.envYoloEnabled({ BANYANCODE_YOLO_MODE: "TRUE" })).toBe(true)
    expect(Yolo.envYoloEnabled({ BANYANCODE_YOLO_MODE: "off" })).toBe(false)
    expect(Yolo.envYoloEnabled({})).toBe(false)
  })
})
