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

  test("accepts banyancode_telemetry on/off", () => {
    const on = Schema.decodeSync(BanyanConfig.Info)({ banyancode_telemetry: "on" })
    expect(on.banyancode_telemetry).toBe("on")
    const off = Schema.decodeSync(BanyanConfig.Info)({ banyancode_telemetry: "off" })
    expect(off.banyancode_telemetry).toBe("off")
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

describe("BanyanConfig.banyancode_jev_tree", () => {
  test("absent struct is valid and stays undefined (feature off)", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({})
    expect(result.banyancode_jev_tree).toBeUndefined()
  })

  test("accepts the fully populated budget struct", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_tree: {
        enabled: true,
        maxDepth: 4,
        maxNodes: 12,
        maxJevCalls: 8,
        timeoutMs: 1500,
        runTimeoutMs: 30000,
        maxBytes: 262144,
      },
    })
    expect(result.banyancode_jev_tree).toEqual({
      enabled: true,
      maxDepth: 4,
      maxNodes: 12,
      maxJevCalls: 8,
      timeoutMs: 1500,
      runTimeoutMs: 30000,
      maxBytes: 262144,
    })
  })

  test("every budget field is optional; only `enabled` gates the feature", () => {
    const minimal = Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_tree: { enabled: true } })
    expect(minimal.banyancode_jev_tree).toEqual({ enabled: true })
    const budgetsOnly = Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_tree: { maxDepth: 6 } })
    expect(budgetsOnly.banyancode_jev_tree?.enabled).toBeUndefined()
  })

  test("rejects wrong field types", () => {
    expect(() =>
      Schema.decodeUnknownSync(BanyanConfig.Info)({ banyancode_jev_tree: { enabled: "yes" } }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(BanyanConfig.Info)({ banyancode_jev_tree: { maxNodes: "twelve" } }),
    ).toThrow()
  })
})
