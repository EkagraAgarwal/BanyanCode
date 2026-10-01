import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BanyanConfig, ThinkingLevelSchema } from "../../src/v1/config/banyan-config"

describe("BanyanConfig.banyancode_jev_profile", () => {
  test("absent profile is valid (conservative default-off behavior)", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({})
    expect(result.banyancode_jev_profile).toBeUndefined()
  })

  test("accepts conservative and aggressive", () => {
    expect(
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_profile: "conservative" }).banyancode_jev_profile,
    ).toBe("conservative")
    expect(Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_profile: "aggressive" }).banyancode_jev_profile).toBe(
      "aggressive",
    )
  })

  test("rejects unknown profiles", () => {
    expect(() => Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_profile: "auto" as never })).toThrow()
  })
})

describe("BanyanConfig.banyancode_jev_features", () => {
  test("accepts per-feature boolean overrides", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_features: { "turn-routing": true, judge: false },
    })
    expect(result.banyancode_jev_features).toEqual({ "turn-routing": true, judge: false })
  })

  test("rejects non-boolean overrides", () => {
    expect(() =>
      Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_features: { "turn-routing": "yes" as never } }),
    ).toThrow()
  })
})

describe("BanyanConfig.banyancode_jev_model_tiers", () => {
  test("accepts fast/strong models with thinking levels", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_model_tiers: {
        fast: "prov/fast-model",
        strong: "prov/strong-model",
        fastThinking: "low",
        strongThinking: "high",
      },
    })
    expect(result.banyancode_jev_model_tiers).toEqual({
      fast: "prov/fast-model",
      strong: "prov/strong-model",
      fastThinking: "low",
      strongThinking: "high",
    })
  })

  test("thinking levels accept explicit variant ids", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_model_tiers: { fast: "a", strong: "b", fastThinking: "custom-variant" },
    })
    expect(result.banyancode_jev_model_tiers?.fastThinking).toBe("custom-variant")
  })

  test("thinking fields are optional", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_model_tiers: { fast: "a", strong: "b" },
    })
    expect(result.banyancode_jev_model_tiers?.fastThinking).toBeUndefined()
  })

  test("rejects tiers missing a model", () => {
    expect(() => Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_model_tiers: { fast: "a" } as never })).toThrow()
  })
})

describe("BanyanConfig.banyancode_jev_budget", () => {
  test("accepts per-turn and per-session budgets", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_budget: { perTurnCalls: 2, perSessionUsd: 0.5 },
    })
    expect(result.banyancode_jev_budget).toEqual({ perTurnCalls: 2, perSessionUsd: 0.5 })
  })

  test("empty budget struct is valid", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_budget: {} })
    expect(result.banyancode_jev_budget).toEqual({})
  })
})

describe("BanyanConfig.banyancode_jev_client", () => {
  test("accepts the fully populated client bounds", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({
      banyancode_jev_client: {
        maxInflight: 4,
        requestsPerMinute: 60,
        tokensPerMinute: 100_000,
        cacheMaxEntries: 128,
        cacheTtlMs: 300_000,
        retries: 2,
      },
    })
    expect(result.banyancode_jev_client?.maxInflight).toBe(4)
    expect(result.banyancode_jev_client?.retries).toBe(2)
  })

  test("partial client bounds are valid", () => {
    const result = Schema.decodeSync(BanyanConfig.Info)({ banyancode_jev_client: { retries: 0 } })
    expect(result.banyancode_jev_client).toEqual({ retries: 0 })
  })
})

describe("BanyanConfig.ThinkingLevelSchema", () => {
  test("accepts known levels and explicit variant ids", () => {
    expect(Schema.decodeSync(ThinkingLevelSchema)("high")).toBe("high")
    expect(Schema.decodeSync(ThinkingLevelSchema)("custom-variant")).toBe("custom-variant")
  })
})
