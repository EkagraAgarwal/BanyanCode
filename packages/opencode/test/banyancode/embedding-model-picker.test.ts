import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EmbeddingProvider } from "../../../core/src/banyancode/embedding-provider"
import { Banyan } from "../../../core/src/banyancode"
import { PluginV2 } from "../../../core/src/plugin"

const mockCodegraphRepoLayer = Layer.succeed(Banyan.CodegraphRepo, Banyan.CodegraphRepo.of({
  resetEmbeddingsTable: () => Effect.void,
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
  listAllEdges: () => Effect.succeed([]) as any,
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

const mockPluginLayer = (captured: { model?: string }) =>
  Layer.succeed(PluginV2.Service, PluginV2.Service.of({
    add: () => Effect.void,
    remove: () => Effect.void,
    triggerFor: () => Effect.succeed({} as any),
    trigger: (_name: string, input: any, output: any) => {
      captured.model = input.model
      const inputArr = input?.input
      const inputLen = Array.isArray(inputArr) ? inputArr.length : 1
      const embeddings = Array.from({ length: inputLen }, () => [0.1, 0.2, 0.3])
      return Effect.succeed({ ...input, ...output, embeddings })
    },
  } as any))

describe("embedding-model-picker", () => {
  test("setModel updates the provider model for live reload", async () => {
    const captured: { model?: string } = {}
    const provider = EmbeddingProvider.defaultLayer.pipe(
      Layer.provide(mockPluginLayer(captured)),
      Layer.provideMerge(mockCodegraphRepoLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* EmbeddingProvider.EmbeddingProviderService
        yield* svc.setModel("openai/text-embedding-3-small")
        yield* svc.embed("hello world")
      }).pipe(Effect.provide(provider)),
    )
    expect(captured.model).toBe("openai/text-embedding-3-small")
  })

  test("setModel with undefined clears the model", async () => {
    const captured: { model?: string } = {}
    const provider = EmbeddingProvider.defaultLayer.pipe(
      Layer.provide(mockPluginLayer(captured)),
      Layer.provideMerge(mockCodegraphRepoLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* EmbeddingProvider.EmbeddingProviderService
        yield* svc.setModel("openai/text-embedding-3-small")
        yield* svc.setModel(undefined)
        const model = svc.model()
        expect(model).toBeUndefined()
      }).pipe(Effect.provide(provider)),
    )
  })
})
