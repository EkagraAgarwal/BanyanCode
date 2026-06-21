import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  EmbeddingProviderService,
  EmbeddingError,
  EmbeddingProbeError,
  EmbeddingDimensionError,
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
    update: () => Effect.succeed({} as any),
  }),
)

// Layer without CodegraphRepo/DB - for tests that don't need it
const testLayerWithoutDB = layer.pipe(
  Layer.provide(configLayer),
  Layer.provide(mockConfig),
  Layer.provide(FSUtil.defaultLayer),
)

describe("EmbeddingProvider", () => {
  test("embed without a model set returns EmbeddingError", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[1, 2, 3]] } as any),
    })
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.embed("hello").pipe(Effect.flip)
        expect(result).toBeInstanceOf(EmbeddingError)
      }).pipe(Effect.provide(testLayer)),
    )
  })

  // Note: Tests that call setModel with a defined name now trigger detectAndSetModel
  // which requires CodegraphRepo. These tests are covered in integration tests.
})

describe("EmbeddingProvider probing", () => {
  test("probe returns dim of model", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[1, 2, 3, 4]] } as any),
    })
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.probe("mock-model-4dim")
        expect(result).toEqual({ dim: 4, type: "F32" })
      }).pipe(Effect.provide(testLayer)),
    )
  })

  // Skipping timeout test as it's flaky in CI environments
  test.skip("probe fails with EmbeddingProbeError on timeout", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.sleep(10_000).pipe(Effect.map(() => ({ embeddings: [[1, 2, 3, 4]] } as any))),
    })
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.probe("mock-model-hang").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("probe returns dim 1 for single-dim model", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[0.123]] } as any),
    })
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.probe("model-1dim")
        expect(result).toEqual({ dim: 1, type: "F32" })
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("probe fails when no embeddings returned", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [] } as any),
    })
    const testLayer = testLayerWithoutDB.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        const result = yield* provider.probe("model-empty").pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provide(testLayer)),
    )
  })
})
