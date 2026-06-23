import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  EmbeddingProviderService,
  EmbeddingError,
  layer,
  configLayer,
} from "../../src/banyancode/embedding-provider"
import { PluginV2 } from "../../src/plugin"
import { BanyanConfigService } from "../../src/banyancode/banyan-config"
import { FSUtil } from "../../src/fs-util"

const mockConfig = Layer.succeed(
  BanyanConfigService.Service,
  BanyanConfigService.Service.of({
    get: () => Effect.succeed({} as any),
    getGlobal: () => Effect.succeed({} as any),
    update: (patch: any) => Effect.succeed({ ...patch } as any),
  }),
)

const testLayerWithoutDB = layer.pipe(
  Layer.provide(configLayer),
  Layer.provide(mockConfig),
  Layer.provide(FSUtil.defaultLayer),
)

const makeMock = (embeddings: number[][]) =>
  Layer.mock(PluginV2.Service)({
    add: () => Effect.void,
    remove: () => Effect.void,
    triggerFor: () => Effect.succeed({} as any),
    trigger: () => Effect.succeed({ embeddings } as any),
  })

describe("EmbeddingProvider", () => {
  test("embed without a model set returns EmbeddingError", async () => {
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(makeMock([[1, 2, 3]])))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.embed("hello").pipe(Effect.flip)
        expect(result).toBeInstanceOf(EmbeddingError)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("embed with model set returns Float32Array vectors of the right size", async () => {
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(makeMock([[0.1, 0.2, 0.3, 0.4]])))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("mock-model")
        const vectors = yield* provider.embed("hello")
        expect(vectors).toHaveLength(1)
        expect(vectors[0]).toBeInstanceOf(Float32Array)
        expect(vectors[0]?.length).toBe(4)
        expect(vectors[0]?.[0]).toBeCloseTo(0.1)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("setModel with undefined clears the model", async () => {
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(makeMock([[0.1, 0.2, 0.3]])))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("openai/text-embedding-3-small")
        yield* provider.setModel(undefined)
        const model = yield* provider.model()
        expect(model).toBeUndefined()
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("model() returns the active model name", async () => {
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(makeMock([[0.1, 0.2, 0.3]])))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("openai/text-embedding-3-small")
        expect(yield* provider.model()).toBe("openai/text-embedding-3-small")
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("embed wraps plugin errors in EmbeddingError", async () => {
    const failingPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.fail("plugin rejected the request") as any,
    })
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(failingPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("mock-model")
        const result = yield* provider.embed("hello").pipe(Effect.flip)
        expect(result).toBeInstanceOf(EmbeddingError)
      }).pipe(Effect.provide(testLayer)),
    )
  })
})
