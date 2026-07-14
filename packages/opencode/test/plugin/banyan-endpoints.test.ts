import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { BanyanConfig } from "@opencode-ai/core/v1/config/banyan-config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("PR 5: BanyanConfig banyancode_openai_compatible_endpoints schema", () => {
  it.effect("parses a minimal endpoint entry", () =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeEffect(BanyanConfig.Info)({
        banyancode_openai_compatible_endpoints: [
          {
            name: "minimax-coding-plan",
            base_url: "https://api.minimax.io/v1",
            models: ["MiniMax-M3"],
          },
        ],
      })
      expect(parsed.banyancode_openai_compatible_endpoints?.[0].name).toBe("minimax-coding-plan")
      expect(parsed.banyancode_openai_compatible_endpoints?.[0].base_url).toBe(
        "https://api.minimax.io/v1",
      )
      expect(parsed.banyancode_openai_compatible_endpoints?.[0].models).toEqual(["MiniMax-M3"])
    }),
  )

  it.effect("parses an endpoint with an optional api_key", () =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeEffect(BanyanConfig.Info)({
        banyancode_openai_compatible_endpoints: [
          {
            name: "minimax-coding-plan",
            base_url: "https://api.minimax.io/v1",
            api_key: "sk-test",
            models: ["MiniMax-M3", "MiniMax-M2.7"],
          },
        ],
      })
      expect(parsed.banyancode_openai_compatible_endpoints?.[0].api_key).toBe("sk-test")
      expect(parsed.banyancode_openai_compatible_endpoints?.[0].models).toEqual(["MiniMax-M3", "MiniMax-M2.7"])
    }),
  )
})

describe("PR 5: BanyanConfigService exposes endpoints", () => {
  it.effect("returns configured endpoints via get()", () =>
    Effect.gen(function* () {
      const svc = yield* Banyan.BanyanConfigService
      const cfg = yield* svc.get()
      expect(cfg.banyancode_openai_compatible_endpoints?.[0].name).toBe("minimax-coding-plan")
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Banyan.BanyanConfigService,
          Banyan.BanyanConfigService.of({
            get: () =>
              Effect.succeed({
                banyancode_openai_compatible_endpoints: [
                  {
                    name: "minimax-coding-plan",
                    base_url: "https://api.minimax.io/v1",
                    api_key: "sk-test",
                    models: ["MiniMax-M3"],
                  },
                ],
              }),
            getGlobal: () => Effect.succeed({}),
            update: () => Effect.succeed({}),
            updateAgentOverride: () => Effect.succeed({}),
            getAgentOverrides: () => Effect.succeed([]),
            updateAgentPrompt: () => Effect.succeed({}),
          }),
        ),
      ),
    ),
  )
})