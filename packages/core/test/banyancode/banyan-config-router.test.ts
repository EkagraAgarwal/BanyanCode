import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BanyanConfig } from "../../src/v1/config/banyan-config"

describe("BanyanConfig router flag", () => {
  test("banyancode_router is undefined when omitted (off by default at consumer level)", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({})
    expect(result.banyancode_router).toBeUndefined()
  })

  test("parses banyancode_router: rules", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({ banyancode_router: "rules" })
    expect(result.banyancode_router).toBe("rules")
  })

  test("parses banyancode_router: needle", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({ banyancode_router: "needle" })
    expect(result.banyancode_router).toBe("needle")
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
})
