import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  EmbeddingProviderService,
  EmbeddingProbeError,
  layer,
  configLayer,
} from "../../src/banyancode/embedding-provider"
import { PluginV2 } from "../../src/plugin"
import { BanyanConfigService } from "../../src/banyancode/banyan-config"
import { FSUtil } from "../../src/fs-util"

// Mock config service
const mockConfig = (config = {}) =>
  Layer.succeed(
    BanyanConfigService.Service,
    BanyanConfigService.Service.of({
      get: () => Effect.succeed({} as any),
      getGlobal: () => Effect.succeed({} as any),
      update: () => Effect.succeed(config as any),
    }),
  )

// Mock plugin that returns embeddings of specific dimensions
const mockPlugin = (dim: number) =>
  Layer.mock(PluginV2.Service)({
    add: () => Effect.void,
    remove: () => Effect.void,
    triggerFor: () => Effect.succeed({} as any),
    trigger: () =>
      Effect.succeed({
        embeddings: [Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0))],
      } as any),
  })

describe("EmbeddingProvider.probe", () => {
  test("probe returns correct dim for 4-dim model", async () => {
    const testLayer = layer.pipe(
      Layer.provide(configLayer),
      Layer.provide(mockConfig()),
      Layer.provide(mockPlugin(4)),
      Layer.provide(FSUtil.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.probe("test-model/4dim")
        expect(result).toEqual({ dim: 4, type: "F32" })
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("probe returns correct dim for 1536-dim model", async () => {
    const testLayer = layer.pipe(
      Layer.provide(configLayer),
      Layer.provide(mockConfig()),
      Layer.provide(mockPlugin(1536)),
      Layer.provide(FSUtil.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.probe("openai/text-embedding-3-large")
        expect(result).toEqual({ dim: 1536, type: "F32" })
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("probe fails with EmbeddingProbeError when no embeddings returned", async () => {
    const emptyPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [] } as any),
    })

    const testLayer = layer.pipe(
      Layer.provide(configLayer),
      Layer.provide(mockConfig()),
      Layer.provide(emptyPlugin),
      Layer.provide(FSUtil.defaultLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.probe("empty-model").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(testLayer)),
    )
  })
})
