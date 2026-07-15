import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { readAgentModelOverride } from "../../src/session/prompt"

const coderOverride = { providerID: "minimax", modelID: "MiniMax-M3" } as any
const exploreOverride = { providerID: "minimax", modelID: "MiniMax-M2" } as any

describe("readAgentModelOverride", () => {
  test("returns undefined when BanyanConfigService is not in scope", async () => {
    const layer = Layer.empty
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* readAgentModelOverride("coder")
      }).pipe(Effect.provide(layer)),
    )
    expect(result).toBeUndefined()
  })

  test("returns undefined when agent name has no override", async () => {
    const mockLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: () => Effect.succeed({}),
        updateAgentOverride: () => Effect.succeed({}),
        getAgentOverrides: () => Effect.succeed({}),
        updateAgentPrompt: () => Effect.succeed({}),
      }),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* readAgentModelOverride("coder")
      }).pipe(Effect.provide(mockLayer)),
    )
    expect(result).toBeUndefined()
  })

  test("returns the override when the agent name is configured", async () => {
    const mockLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: () => Effect.succeed({}),
        updateAgentOverride: () => Effect.succeed({}),
        getAgentOverrides: () => Effect.succeed({ coder: { model: "minimax/MiniMax-M3" } }),
        updateAgentPrompt: () => Effect.succeed({}),
      }),
    )
    const result = (await Effect.runPromise(
      Effect.gen(function* () {
        return yield* readAgentModelOverride("coder")
      }).pipe(Effect.provide(mockLayer)),
    )) as { providerID: string; modelID: string } | undefined
    expect(result).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
  })

  test("returns the correct override per agent when multiple are set", async () => {
    const mockLayer = Layer.succeed(
      Banyan.BanyanConfigService,
      Banyan.BanyanConfigService.of({
        get: () => Effect.succeed({}),
        getGlobal: () => Effect.succeed({}),
        update: () => Effect.succeed({}),
        updateAgentOverride: () => Effect.succeed({}),
        getAgentOverrides: () =>
          Effect.succeed({
            coder: { model: "minimax/MiniMax-M3" },
            explore: { model: "minimax/MiniMax-M2" },
          }),
        updateAgentPrompt: () => Effect.succeed({}),
      }),
    )
    const coder = (await Effect.runPromise(
      Effect.gen(function* () {
        return yield* readAgentModelOverride("coder")
      }).pipe(Effect.provide(mockLayer)),
    )) as { providerID: string; modelID: string } | undefined
    const explore = (await Effect.runPromise(
      Effect.gen(function* () {
        return yield* readAgentModelOverride("explore")
      }).pipe(Effect.provide(mockLayer)),
    )) as { providerID: string; modelID: string } | undefined
    const researcher = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* readAgentModelOverride("researcher")
      }).pipe(Effect.provide(mockLayer)),
    )
    expect(coder).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    expect(explore).toEqual({ providerID: "minimax", modelID: "MiniMax-M2" })
    expect(researcher).toBeUndefined()
  })
})