import { describe, expect, beforeAll, afterAll } from "bun:test"
import { Effect, Layer, type Scope } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelsDevPlugin } from "@opencode-ai/core/plugin/models-dev"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { mkdir, writeFile, rm } from "fs/promises"
import path from "path"

const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH

beforeAll(() => {
  Flag.OPENCODE_MODELS_PATH = undefined
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
})

afterAll(async () => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  await rm(cacheFile, { force: true })
})

const cacheFile = path.join(Global.Path.cache, "models.json")

const mockData: Record<string, ModelsDev.Provider> = {
  minimax: {
    id: "minimax",
    name: "MiniMax",
    env: ["MINIMAX_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "MiniMax-M3": {
        id: "MiniMax-M3",
        name: "MiniMax-M3",
        release_date: "2026-06-01",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        reasoning_options: [{ type: "toggle" }],
        limit: { context: 1000000, output: 128000 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "o3-mini": {
        id: "o3-mini",
        name: "o3-mini",
        release_date: "2025-01-31",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        reasoning_options: [
          {
            type: "effort",
            values: [null, "low", "medium", "high"],
          },
        ],
        limit: { context: 200000, output: 16384 },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-3-7-sonnet": {
        id: "claude-3-7-sonnet",
        name: "Claude 3.7 Sonnet",
        release_date: "2025-02-24",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        reasoning_options: [
          {
            type: "budget_tokens",
            min: 1024,
            max: 64000,
          },
        ],
        limit: { context: 200000, output: 128000 }, // High limit so high and max differ
      },
    },
  },
  experimental: {
    id: "experimental",
    name: "Experimental",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      "exp-model": {
        id: "exp-model",
        name: "Experimental Model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 8192, output: 2048 },
        experimental: {
          modes: {
            custom_mode: {
              provider: {
                body: {
                  someSetting: "value",
                },
              },
            },
          },
        },
      },
      "conflict-model": {
        id: "conflict-model",
        name: "Conflict Model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 8192, output: 4096 },
        reasoning_options: [{ type: "toggle" }],
        experimental: {
          modes: {
            thinking: {
              provider: {
                body: {
                  overriddenField: "specialValue",
                },
              },
            },
          },
        },
      },
    },
  },
}

const writeCache = async () => {
  await mkdir(Global.Path.cache, { recursive: true })
  await writeFile(cacheFile, JSON.stringify(mockData))
}

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)

const it = testEffect(
  Catalog.locationLayer.pipe(
    Layer.provideMerge(locationLayer),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provideMerge(FSUtil.defaultLayer),
    Layer.provideMerge(ModelsDev.defaultLayer),
  ),
)

describe("ModelsDevPlugin Reasoning Variants", () => {
  it.effect("parses reasoning variants and populates the Catalog correctly", () =>
    Effect.gen(function* () {
      yield* Effect.promise(writeCache)
      const catalog = yield* Catalog.Service
      const plugin = yield* PluginV2.Service
      const modelsDev = yield* ModelsDev.Service
      const events = yield* EventV2.Service

      // Add the plugin manually. The plugin's effect depends on Catalog/ModelsDev/EventV2,
      // so we provide those services to its initializer Effect up-front to narrow R to Scope,
      // which matches PluginV2.Interface.add's input constraint.
      const pluginLayer = Layer.mergeAll(
        Layer.succeed(Catalog.Service, catalog),
        Layer.succeed(ModelsDev.Service, modelsDev),
        Layer.succeed(EventV2.Service, events),
      )
      const providedEffect = ModelsDevPlugin.effect.pipe(Effect.provide(pluginLayer)) as Effect.Effect<
        void | PluginV2.HookFunctions,
        never,
        Scope.Scope
      >
      yield* plugin.add({ id: ModelsDevPlugin.id, effect: providedEffect })

      // 1. Check MiniMax (Toggle)
      const minimax = yield* catalog.model.get(
        ProviderV2.ID.make("minimax"),
        ModelV2.ID.make("MiniMax-M3"),
      )
      
      const minimaxThinking = minimax.variants.find((v) => v.id === "thinking")
      const minimaxNone = minimax.variants.find((v) => v.id === "none")
      expect(minimaxThinking).toBeDefined()
      expect(minimaxNone).toBeDefined()
      expect(minimaxThinking?.options?.thinking).toEqual({
        type: "enabled",
        budgetTokens: 32000,
      })

      // 2. Check o3-mini (Effort)
      const o3Mini = yield* catalog.model.get(
        ProviderV2.ID.make("openai"),
        ModelV2.ID.make("o3-mini"),
      )
      expect(o3Mini.variants).toHaveLength(4)
      const effortNone = o3Mini.variants.find((v) => v.id === "none")
      const effortLow = o3Mini.variants.find((v) => v.id === "low")
      const effortHigh = o3Mini.variants.find((v) => v.id === "high")
      expect(effortNone).toBeDefined()
      expect(effortLow).toBeDefined()
      expect(effortHigh).toBeDefined()
      expect(effortLow?.options?.reasoningEffort).toEqual("low")
      expect(effortHigh?.options?.reasoningEffort).toEqual("high")

      // 3. Check claude-3-7-sonnet (Budget)
      const claude = yield* catalog.model.get(
        ProviderV2.ID.make("anthropic"),
        ModelV2.ID.make("claude-3-7-sonnet"),
      )
      expect(claude.variants).toHaveLength(2)
      const budgetHigh = claude.variants.find((v) => v.id === "high")
      const budgetMax = claude.variants.find((v) => v.id === "max")
      expect(budgetHigh).toBeDefined()
      expect(budgetMax).toBeDefined()
      expect(budgetHigh?.options?.thinking).toEqual({
        type: "enabled",
        budgetTokens: 16000, // no longer capped by output limit
      })
      expect(budgetMax?.options?.thinking).toEqual({
        type: "enabled",
        budgetTokens: 64000,
      })

      // 4. Regression check (experimental.modes only)
      const expModel = yield* catalog.model.get(
        ProviderV2.ID.make("experimental"),
        ModelV2.ID.make("exp-model"),
      )
      expect(expModel.variants).toHaveLength(1)
      expect(expModel.variants[0].id).toEqual(ModelV2.VariantID.make("custom_mode"))
      expect(expModel.variants[0].body?.someSetting).toEqual("value")

      // 5. Conflict check (experimental overrides reasoning)
      const conflictModel = yield* catalog.model.get(
        ProviderV2.ID.make("experimental"),
        ModelV2.ID.make("conflict-model"),
      )
      expect(conflictModel.variants).toHaveLength(2) // none (from reasoning) and thinking (overridden by exp)
      const conflictThinking = conflictModel.variants.find((v) => v.id === "thinking")
      const conflictNone = conflictModel.variants.find((v) => v.id === "none")
      expect(conflictNone).toBeDefined()
      expect(conflictThinking).toBeDefined()
      // Overridden by experimental.modes body
      expect(conflictThinking?.body?.overriddenField).toEqual("specialValue")
      // Should not have the default toggle body
      expect(conflictThinking?.options?.thinking).toBeUndefined()
    }),
  )
})
