import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Thinking } from "@opencode-ai/core/banyancode/thinking"
import { withVariant } from "@opencode-ai/core/session/runner/model"
import { ModelV2 } from "@opencode-ai/core/model"
import { BanyanConfig } from "@opencode-ai/core/v1/config/banyan-config"
import { ProviderTransform } from "@/provider/transform"

const baseModel = {
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0.001, output: 0.002, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} as any

const anthropicOpus46 = {
  ...baseModel,
  id: "anthropic/claude-opus-4-6",
  providerID: "anthropic",
  api: { id: "claude-opus-4-6-20260521", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
} as any

const openaiGpt52 = {
  ...baseModel,
  id: "openai/gpt-5.2",
  providerID: "openai",
  api: { id: "gpt-5.2", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
} as any

const openrouterGeneric = {
  ...baseModel,
  id: "anthropic/claude-sonnet-4-5",
  providerID: "openrouter",
  api: { id: "anthropic/claude-sonnet-4-5", url: "https://openrouter.ai", npm: "@openrouter/ai-sdk-provider" },
} as any

const deepseekChat = {
  ...baseModel,
  id: "deepseek/deepseek-chat",
  providerID: "deepseek",
  api: { id: "deepseek-chat", url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
} as any

describe("resolveThinkingVariant", () => {
  test("exact hits pass through (levels and custom variant ids)", () => {
    expect(Thinking.resolveThinkingVariant("high", ["low", "high"])).toBe("high")
    expect(Thinking.resolveThinkingVariant("thinking", ["none", "thinking"])).toBe("thinking")
    expect(Thinking.resolveThinkingVariant("my-custom", ["my-custom", "other"])).toBe("my-custom")
  })

  test("ultra falls back max -> xhigh -> high", () => {
    expect(Thinking.resolveThinkingVariant("ultra", ["low", "medium", "high", "max"])).toBe("max")
    expect(Thinking.resolveThinkingVariant("ultra", ["low", "medium", "high", "xhigh"])).toBe("xhigh")
    expect(Thinking.resolveThinkingVariant("ultra", ["low", "medium", "high"])).toBe("high")
    expect(Thinking.resolveThinkingVariant("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh")
  })

  test("below-level fallback picks the strongest available", () => {
    expect(Thinking.resolveThinkingVariant("high", ["low", "medium"])).toBe("medium")
    expect(Thinking.resolveThinkingVariant("low", ["high"])).toBe("high")
  })

  test("off resolves to the model's off/none key, else omit", () => {
    expect(Thinking.resolveThinkingVariant("off", ["off", "low"])).toBe("off")
    expect(Thinking.resolveThinkingVariant("off", ["none", "low"])).toBe("none")
    expect(Thinking.resolveThinkingVariant("off", ["low", "high"])).toBeUndefined()
  })

  test("unknown levels and empty maps omit (never a 400)", () => {
    expect(Thinking.resolveThinkingVariant("nonsense", ["low", "high"])).toBeUndefined()
    expect(Thinking.resolveThinkingVariant("high", [])).toBeUndefined()
    expect(Thinking.resolveThinkingVariant("high", {})).toBeUndefined()
    expect(Thinking.resolveThinkingVariant(undefined, ["low"])).toBeUndefined()
    expect(Thinking.resolveThinkingVariant(null, ["low"])).toBeUndefined()
  })
})

describe("resolveThinkingLevel", () => {
  test("per-agent override wins, then default, then medium", () => {
    expect(Thinking.resolveThinkingLevel("high", "low")).toBe("high")
    expect(Thinking.resolveThinkingLevel(undefined, "low")).toBe("low")
    expect(Thinking.resolveThinkingLevel(undefined, undefined)).toBe("medium")
    expect(Thinking.resolveThinkingLevel(null, null)).toBe("medium")
  })
})

describe("per-family transform mapping", () => {
  test("anthropic opus-4-6 exposes low/medium/high/max; ultra resolves to max", () => {
    const keys = Object.keys(ProviderTransform.variants(anthropicOpus46))
    expect(keys).toEqual(expect.arrayContaining(["low", "medium", "high", "max"]))
    expect(Thinking.resolveThinkingVariant("ultra", keys)).toBe("max")
  })

  test("openai gpt-5.2 exposes xhigh; ultra resolves to xhigh", () => {
    const keys = Object.keys(ProviderTransform.variants(openaiGpt52))
    expect(keys).toContain("xhigh")
    expect(Thinking.resolveThinkingVariant("ultra", keys)).toBe("xhigh")
  })

  test("openrouter generic reasoning model exposes low/medium/high; ultra resolves to high", () => {
    const keys = Object.keys(ProviderTransform.variants(openrouterGeneric))
    expect(keys).toEqual(expect.arrayContaining(["low", "medium", "high"]))
    expect(Thinking.resolveThinkingVariant("ultra", keys)).toBe("high")
  })

  test("deepseek-chat exposes no variants; thinking is ignored", () => {
    const keys = Object.keys(ProviderTransform.variants(deepseekChat))
    expect(keys).toEqual([])
    expect(Thinking.resolveThinkingVariant("high", keys)).toBeUndefined()
  })
})

describe("withVariant thinking fallback (V2)", () => {
  const catalogModel = {
    providerID: "anthropic",
    id: "claude-opus-4-6",
    request: { headers: {}, body: {}, generation: {}, options: {}, variant: "default" },
    variants: [
      { id: "low", headers: {}, body: {}, generation: {}, options: { effort: "low" } },
      { id: "medium", headers: {}, body: {}, generation: {}, options: { effort: "medium" } },
      { id: "high", headers: {}, body: {}, generation: {}, options: { effort: "high" } },
    ],
  } as unknown as ModelV2.Info

  test("thinking level maps to the nearest catalog variant", () => {
    const result = withVariant(catalogModel, "ultra" as ModelV2.VariantID)
    expect((result.request.options as Record<string, unknown>)["effort"]).toBe("high")
    // Original untouched (immer).
    expect((catalogModel.request.options as Record<string, unknown>)["effort"]).toBeUndefined()
  })

  test("direct variant hit still applies", () => {
    const result = withVariant(catalogModel, "low" as ModelV2.VariantID)
    expect((result.request.options as Record<string, unknown>)["effort"]).toBe("low")
  })

  test("unknown level leaves the model unchanged", () => {
    expect(withVariant(catalogModel, "nonsense" as ModelV2.VariantID)).toBe(catalogModel)
    expect(withVariant(catalogModel, undefined)).toBe(catalogModel)
  })
})

describe("BanyanConfig thinking schema round-trip", () => {
  test("agent thinking/variant + thinking_default + swarm_mode survive JSON", () => {
    const input = {
      banyancode_thinking_default: "high",
      banyancode_swarm_mode: true,
      agent: {
        coder: { thinking: "ultra" },
        scout: { thinking: "low", variant: "fast" },
      },
    }
    const decoded = Schema.decodeUnknownSync(BanyanConfig.Info)(input)
    expect(decoded.banyancode_thinking_default).toBe("high")
    expect(decoded.banyancode_swarm_mode).toBe(true)
    expect(decoded.agent?.["coder"]?.thinking).toBe("ultra")
    expect(decoded.agent?.["scout"]?.thinking).toBe("low")
    expect(decoded.agent?.["scout"]?.variant).toBe("fast")
    const json = JSON.stringify(Schema.encodeSync(BanyanConfig.Info)(decoded))
    const reparsed = Schema.decodeUnknownSync(BanyanConfig.Info)(JSON.parse(json))
    expect(reparsed.agent?.["coder"]?.thinking).toBe("ultra")
    expect(reparsed.banyancode_swarm_mode).toBe(true)
  })

  test("custom variant-id passthrough decodes", () => {
    const decoded = Schema.decodeUnknownSync(BanyanConfig.Info)({
      agent: { researcher: { thinking: "my-custom-variant" } },
    })
    expect(decoded.agent?.["researcher"]?.thinking).toBe("my-custom-variant")
  })
})
