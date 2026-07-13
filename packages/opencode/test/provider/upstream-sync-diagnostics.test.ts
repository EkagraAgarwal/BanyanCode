import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Provider } from "@/provider/provider"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Env } from "@/env"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"

const list = Provider.use.list()

const providerLayer = Provider.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(ModelsDev.defaultLayer),
  Layer.provide(RuntimeFlags.layer({})),
)

const it = testEffect(
  Layer.mergeAll(
    providerLayer,
    Env.defaultLayer,
    Plugin.defaultLayer,
    ModelsDev.defaultLayer,
    RuntimeFlags.layer({}),
  ),
)

describe("PR 3: upstream sync runtime model diagnostics", () => {
  it.effect("custom provider fallback npm default is @ai-sdk/openai-compatible", () =>
    Effect.gen(function* () {
      const customProvider = {
        id: "minimax-coding-plan",
        name: "minimax-coding-plan",
        env: [],
        models: {
          "MiniMax-M3": {
            id: "MiniMax-M3",
            name: "MiniMax-M3",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8000 },
          },
        },
      } as unknown as ModelsDev.Provider

      const model = Provider.fromModelsDevProvider(customProvider).models["MiniMax-M3"]
      console.log(
        "[DIAG] custom minimax-coding-plan fallback",
        JSON.stringify(
          {
            providerID: model.providerID,
            apiID: model.api.id,
            apiNPM: model.api.npm,
            reasoning: model.capabilities.reasoning,
            variants: Object.keys(model.variants ?? {}),
          },
          null,
          2,
        ),
      )
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.api.id).toBe("MiniMax-M3")
      expect(model.capabilities.reasoning).toBe(true)
      expect(Object.keys(model.variants ?? {}).length).toBeGreaterThan(0)
    }),
  )

  it.effect("custom provider fallback also exposes reasoning variants for DeepSeek V4 Pro", () =>
    Effect.gen(function* () {
      const customProvider = {
        id: "custom-deepseek",
        name: "custom-deepseek",
        env: [],
        models: {
          "deepseek-v4-pro": {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            attachment: false,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 1000000, output: 384000 },
          },
        },
      } as unknown as ModelsDev.Provider

      const model = Provider.fromModelsDevProvider(customProvider).models["deepseek-v4-pro"]
      console.log(
        "[DIAG] custom deepseek-v4-pro fallback",
        JSON.stringify(
          {
            providerID: model.providerID,
            apiID: model.api.id,
            apiNPM: model.api.npm,
            reasoning: model.capabilities.reasoning,
            variants: Object.keys(model.variants ?? {}),
          },
          null,
          2,
        ),
      )
      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(model.capabilities.reasoning).toBe(true)
    }),
  )
})

describe("PR 3: provider loader produces expected variants for reasoning models", () => {
  it.instance(
    "MiniMax-M3 exposes reasoning variants after upstream sync",
    Effect.gen(function* () {
      const providers = yield* list
      const provider = providers[ProviderV2.ID.make("minimax")]
      if (!provider) {
        console.log("[DIAG] minimax provider not loaded")
        return
      }
      const model = provider.models[ModelV2.ID.make("MiniMax-M3")]
      if (!model) {
        console.log("[DIAG] MiniMax-M3 model not in loaded minimax provider")
        return
      }
      console.log(
        "[DIAG] loader MiniMax-M3",
        JSON.stringify(
          {
            apiNPM: model.api.npm,
            variants: Object.keys(model.variants ?? {}),
          },
          null,
          2,
        ),
      )
      expect(model.capabilities.reasoning).toBe(true)
      expect(Object.keys(model.variants ?? {}).length).toBeGreaterThan(0)
    }),
    {
      config: {
        provider: {
          minimax: { options: { apiKey: "test-fixture-key" } },
        },
      },
    },
  )

  it.instance(
    "DeepSeek V4 Pro exposes reasoning variants after upstream sync",
    Effect.gen(function* () {
      const providers = yield* list
      const provider = providers[ProviderV2.ID.make("deepseek")]
      if (!provider) {
        console.log("[DIAG] deepseek provider not loaded")
        return
      }
      const candidates = ["deepseek-v4-pro", "DeepSeek-V4-Pro"]
      const model = candidates
        .map((id) => provider.models[ModelV2.ID.make(id)])
        .find((m): m is NonNullable<typeof m> => Boolean(m))
      if (!model) {
        console.log("[DIAG] DeepSeek V4 Pro model not in loaded deepseek provider")
        return
      }
      console.log(
        "[DIAG] loader DeepSeek V4 Pro",
        JSON.stringify(
          {
            apiNPM: model.api.npm,
            variants: Object.keys(model.variants ?? {}),
          },
          null,
          2,
        ),
      )
      expect(model.capabilities.reasoning).toBe(true)
      expect(Object.keys(model.variants ?? {}).length).toBeGreaterThan(0)
    }),
    {
      config: {
        provider: {
          deepseek: { options: { apiKey: "test-fixture-key" } },
        },
      },
    },
  )
})