import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BanyanConfig } from "../../src/v1/config/banyan-config"

describe("BanyanConfig router flag", () => {
  test("banyancode_router is undefined when omitted (consumer defaults to rules at the gateway layer)", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({})
    expect(result.banyancode_router).toBeUndefined()
  })

  test("parses banyancode_router: rules", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({ banyancode_router: "rules" })
    expect(result.banyancode_router).toBe("rules")
  })

  test("parses banyancode_router: off", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({ banyancode_router: "off" })
    expect(result.banyancode_router).toBe("off")
  })

  test("rejects an invalid banyancode_router value", () => {
    expect(() =>
      Schema.decodeUnknownSync(BanyanConfig.Info)({ banyancode_router: "bogus" }),
    ).toThrow()
  })

  test("per-tool route flags and router_trace are undefined when omitted", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({})
    expect(result.banyancode_route_grep).toBeUndefined()
    expect(result.banyancode_route_read).toBeUndefined()
    expect(result.banyancode_route_glob).toBeUndefined()
    expect(result.banyancode_router_trace).toBeUndefined()
  })

  test("parses banyancode_route_grep/read/glob and banyancode_router_trace booleans", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_route_grep: false,
      banyancode_route_read: true,
      banyancode_route_glob: false,
      banyancode_router_trace: true,
    })
    expect(result.banyancode_route_grep).toBe(false)
    expect(result.banyancode_route_read).toBe(true)
    expect(result.banyancode_route_glob).toBe(false)
    expect(result.banyancode_router_trace).toBe(true)
  })
})
