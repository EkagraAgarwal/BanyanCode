import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EmbeddingProviderService, EmbeddingError, layer as baseLayer, configLayer } from "../../src/banyancode/embedding-provider"
import { PluginV2 } from "../../src/plugin"
import { BanyanConfigService } from "../../src/banyancode/banyan-config"

const mockConfig = Layer.succeed(
  BanyanConfigService.Service,
  BanyanConfigService.Service.of({
    get: () => Effect.succeed({} as any),
    getGlobal: () => Effect.succeed({} as any),
    update: () => Effect.succeed({} as any),
  }),
)

const testLayerBase = baseLayer.pipe(
  Layer.provide(configLayer),
  Layer.provide(mockConfig),
)

describe("EmbeddingProvider", () => {
  test("embed without a model set returns EmbeddingError", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[1, 2, 3]] } as any),
    })
    const layer = testLayerBase.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.embed("hello").pipe(Effect.flip)
        expect(result).toBeInstanceOf(EmbeddingError)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("setModel then embed invokes plugin with correct model", async () => {
    let capturedModel: string | undefined

    const captureLayer = Layer.effect(
      PluginV2.Service,
      Effect.gen(function* () {
        return {
          add: () => Effect.void,
          remove: () => Effect.void,
          triggerFor: () => Effect.succeed({} as any),
          trigger: (_name: string, input: any, output: any) => {
            capturedModel = input.model
            return Effect.succeed({
              ...input,
              ...output,
            })
          },
        }
      }),
    )

    const testLayer = testLayerBase.pipe(Layer.provide(captureLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("test/model")
        yield* provider.embed("hello")
      }).pipe(Effect.provide(testLayer)),
    )
    expect(capturedModel).toBe("test/model")
  })

  test("setModel(undefined) puts provider back in degraded mode", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[1, 2, 3]] } as any),
    })
    const layer = testLayerBase.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("test/model")
        yield* provider.setModel(undefined)
        const result = yield* provider.embed("hello").pipe(Effect.flip)
        expect(result).toBeInstanceOf(EmbeddingError)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("model returns the latest set value", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[1, 2, 3]] } as any),
    })
    const layer = testLayerBase.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        expect(provider.model()).toBeUndefined()
        yield* provider.setModel("custom/model")
        expect(provider.model()).toBe("custom/model")
        yield* provider.setModel("another/model")
        expect(provider.model()).toBe("another/model")
        yield* provider.setModel(undefined)
        expect(provider.model()).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})
