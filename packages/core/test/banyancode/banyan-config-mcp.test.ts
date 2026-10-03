import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BanyanConfig } from "../../src/v1/config/banyan-config"

describe("BanyanConfig.banyancode_mcp_server", () => {
  test("absent struct is valid (reject-everything defaults)", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({})
    expect(result.banyancode_mcp_server).toBeUndefined()
  })

  test("accepts a fully populated struct", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_mcp_server: {
        default_agent: "build",
        default_model: "provider/model",
        permission: "reject",
        max_concurrent_tasks: 4,
        result_max_tokens: 1500,
        needs_input_timeout_seconds: 600,
        tools: ["task", "code", "memory", "verify"],
      },
    })
    expect(result.banyancode_mcp_server).toEqual({
      default_agent: "build",
      default_model: "provider/model",
      permission: "reject",
      max_concurrent_tasks: 4,
      result_max_tokens: 1500,
      needs_input_timeout_seconds: 600,
      tools: ["task", "code", "memory", "verify"],
    })
  })

  test("accepts edits permission and rejects yolo (flag-only escalation)", () => {
    const edits = Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { permission: "edits" } })
    expect(edits.banyancode_mcp_server?.permission).toBe("edits")
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { permission: "yolo" as never } }),
    ).toThrow()
  })

  test("rejects wrong types", () => {
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { max_concurrent_tasks: "4" as never } }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { result_max_tokens: 1.5 as never } }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { tools: "task" as never } }),
    ).toThrow()
  })

  test("rejects out-of-range bounds", () => {
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { max_concurrent_tasks: 0 } }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { needs_input_timeout_seconds: 30 } }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_mcp_server: { tools: ["../escape" as never] } }),
    ).toThrow()
  })
})
