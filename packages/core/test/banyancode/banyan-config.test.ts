import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BanyanConfig } from "../../src/v1/config/banyan-config"

describe("BanyanConfig", () => {
  test("validates banyancode_yolo_mode and banyancode_disable_websearch", () => {
    const input = {
      banyancode_yolo_mode: true,
      banyancode_disable_websearch: true,
    }
    const result = Schema.decodeSync(BanyanConfig.Info)(input)
    expect(result.banyancode_yolo_mode).toBe(true)
    expect(result.banyancode_disable_websearch).toBe(true)
  })

  test("accepts unknown keys without throwing", () => {
    const input = {
      banyancode_yolo_mode: true,
      unknown_key: "value",
    }
    const result = Schema.decodeSync(BanyanConfig.Info)(input)
    expect(result.banyancode_yolo_mode).toBe(true)
  })

  test("accepts $schema field", () => {
    const input = { $schema: "https://banyan.dev/schema/banyancode.json" }
    const result = Schema.decodeSync(BanyanConfig.Info)(input)
    expect(result.$schema).toBe("https://banyan.dev/schema/banyancode.json")
  })

  test("empty config is valid", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({})
    expect(result).toEqual({})
  })
})
