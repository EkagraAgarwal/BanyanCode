import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EmbeddingProviderService } from "../../../core/src/banyancode/embedding-provider"
import { defaultLayer } from "../../../core/src/banyancode/embedding-provider"
import { PluginV2 } from "../../../core/src/plugin"

describe("embedding-model-picker", () => {
  test("setModel updates the provider model for live reload", async () => {
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

    const testLayer = defaultLayer.pipe(Layer.provide(captureLayer))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("openai/text-embedding-3-small")
        yield* provider.embed("hello world")
      }).pipe(Effect.provide(testLayer)),
    )
    expect(capturedModel).toBe("openai/text-embedding-3-small")
  })

  test("setModel with undefined clears the model", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[1, 2, 3]] } as any),
    })
    const layer = defaultLayer.pipe(Layer.provide(mockPlugin))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* EmbeddingProviderService
        yield* provider.setModel("openai/text-embedding-3-small")
        yield* provider.setModel(undefined)
        const model = provider.model()
        expect(model).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })
})
