import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EmbeddingProviderService } from "../../../core/src/banyancode/embedding-provider"
import { defaultLayer } from "../../../core/src/banyancode/embedding-provider"
import { Banyan } from "../../../core/src/banyancode"
import { PluginV2 } from "../../../core/src/plugin"

const mockCodegraphRepoLayer = Layer.succeed(Banyan.CodegraphRepo, Banyan.CodegraphRepo.of({
  resetEmbeddingsTable: () => Effect.succeed(undefined),
  searchByVector: () => Effect.succeed([]),
  putFile: () => Effect.void as any,
  getFile: () => Effect.succeed(undefined) as any,
  getFileByPath: () => Effect.succeed(undefined) as any,
  listAllFiles: () => Effect.succeed([]) as any,
  putNode: () => Effect.void as any,
  getNode: () => Effect.succeed(undefined) as any,
  nodeByID: () => Effect.succeed(undefined) as any,
  listNodesByFile: () => Effect.succeed([]) as any,
  listAllNodes: () => Effect.succeed([]) as any,
  queryNodes: () => Effect.succeed([]) as any,
  putEdge: () => Effect.void as any,
  getEdge: () => Effect.succeed(undefined) as any,
  listEdgesByNode: () => Effect.succeed([]) as any,
  edgesFrom: () => Effect.succeed([]) as any,
  edgesTo: () => Effect.succeed([]) as any,
  putEmbedding: () => Effect.void as any,
  getEmbedding: () => Effect.succeed(undefined) as any,
  deleteFile: () => Effect.void as any,
  clearAll: () => Effect.void as any,
  getMeta: () => Effect.succeed(undefined) as any,
  setMeta: () => Effect.void as any,
  bumpVersion: () => Effect.succeed({ graphVersion: 1, coverage: 1 }) as any,
}))

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

    const testLayer = Layer.mergeAll(
      defaultLayer,
      mockCodegraphRepoLayer,
      captureLayer,
    )

    const testEffect = Effect.gen(function* () {
      const provider = yield* EmbeddingProviderService
      yield* provider.setModel("openai/text-embedding-3-small")
      yield* provider.embed("hello world")
    }).pipe(Effect.provide(testLayer)) as any

    await Effect.runPromise(testEffect)
    expect(capturedModel).toBe("openai/text-embedding-3-small")
  })

  test("setModel with undefined clears the model", async () => {
    const mockPlugin = Layer.mock(PluginV2.Service)({
      add: () => Effect.void,
      remove: () => Effect.void,
      triggerFor: () => Effect.succeed({} as any),
      trigger: () => Effect.succeed({ embeddings: [[1, 2, 3]] } as any),
    })
    const layer = defaultLayer
      .pipe(Layer.provide(mockCodegraphRepoLayer))
      .pipe(Layer.provide(mockPlugin))

    const testEffect2 = Effect.gen(function* () {
      const provider = yield* EmbeddingProviderService
      yield* provider.setModel("openai/text-embedding-3-small")
      yield* provider.setModel(undefined)
      const model = provider.model()
      expect(model).toBeUndefined()
    }).pipe(Effect.provide(layer)) as any

    await Effect.runPromise(testEffect2)
  })
})
