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

  test("accepts banyancode_lsp: true", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({ banyancode_lsp: true })
    expect(result.banyancode_lsp).toBe(true)
  })

  test("accepts banyancode_lsp as a per-server record", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_lsp: {
        typescript: { disabled: true },
        custom: { command: ["my-lsp", "--stdio"], extensions: [".my"] },
      },
    })
    const lsp = result.banyancode_lsp as {
      typescript: { disabled: boolean }
      custom: { command: string[]; extensions: string[] }
    }
    expect(lsp.typescript.disabled).toBe(true)
    expect(lsp.custom.command).toEqual(["my-lsp", "--stdio"])
  })

  test("rejects banyancode_lsp custom server missing extensions", () => {
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({
        banyancode_lsp: {
          notabuiltin: { command: ["my-lsp", "--stdio"] },
        },
      }),
    ).toThrow()
  })
})
