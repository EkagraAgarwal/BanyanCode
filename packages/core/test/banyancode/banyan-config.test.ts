import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BanyanConfig } from "../../src/v1/config/banyan-config"

describe("BanyanConfig", () => {
  test("validates banyancode_yolo_mode", () => {
    const input = {
      banyancode_yolo_mode: true,
    }
    const result = Schema.decodeSync(BanyanConfig.Info)(input)
    expect(result.banyancode_yolo_mode).toBe(true)
  })

  test("accepts unknown keys without throwing", () => {
    const input = {
      unknown_key: "value",
    }
    expect(() => Schema.decodeUnknownSync(BanyanConfig.Info)(input)).not.toThrow()
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
