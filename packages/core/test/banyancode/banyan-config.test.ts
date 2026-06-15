import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BanyanConfig } from "../../src/v1/config/banyan-config"

describe("BanyanConfig", () => {
  test("validates banyancode_embedding_model and banyancode_yolo_mode", () => {
    const input = {
      banyancode_embedding_model: "openai/text-embedding-3-small",
      banyancode_yolo_mode: true,
    }
    const result = Schema.decodeSync(BanyanConfig.Info)(input)
    expect(result.banyancode_embedding_model).toBe("openai/text-embedding-3-small")
    expect(result.banyancode_yolo_mode).toBe(true)
  })

  test("accepts unknown keys without throwing", () => {
    const input = {
      banyancode_embedding_model: "openai/text-embedding-3-small",
      unknown_key: "value",
    }
    const result = Schema.decodeSync(BanyanConfig.Info)(input)
    expect(result.banyancode_embedding_model).toBe("openai/text-embedding-3-small")
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
