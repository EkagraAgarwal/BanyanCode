export * as CodegraphEmbedder from "./codegraph-embedder"

import { Context, Effect, Layer } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import { EmbeddingProvider } from "./embedding-provider"
import type { CodegraphNode } from "./types"

export interface Interface {
  readonly embedAll: () => Effect.Effect<{ embedded: number; skipped: number; model: string | undefined }>
  readonly embedFile: (fileID: string) => Effect.Effect<{ embedded: number; skipped: number }>
  readonly embedNode: (node: CodegraphNode) => Effect.Effect<void, EmbeddingProvider.EmbeddingError>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphEmbedder") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const provider = yield* EmbeddingProvider.EmbeddingProviderService

    const embedNode = Effect.fn("CodegraphEmbedder.embedNode")(function* (node: CodegraphNode) {
      const text = node.code ?? `${node.name}${node.signature ? " " + node.signature : ""}`
      const embeddings = yield* provider.embed(text)
      const embedding = embeddings[0]
      const model = provider.model()
      if (model === undefined) {
        return yield* new EmbeddingProvider.EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not set" })
      }
      const bytes = new Uint8Array(embedding.buffer)
      yield* repo.putEmbedding(node.id, bytes, model, embedding.length)
    })

    const embedFile = Effect.fn("CodegraphEmbedder.embedFile")(function* (fileID: string) {
      const nodes = yield* repo.listNodesByFile(fileID)
      let embedded = 0
      let skipped = 0
      for (const node of nodes) {
        const existing = yield* repo.getEmbedding(node.id)
        if (existing) {
          skipped++
          continue
        }
        yield* embedNode(node).pipe(Effect.catch(() => Effect.void))
        embedded++
      }
      return { embedded, skipped }
    })

    const embedAll = Effect.fn("CodegraphEmbedder.embedAll")(function* () {
      const allNodes = yield* repo.listAllNodes()
      const model = provider.model()
      const byFile = new Map<string, CodegraphNode[]>()
      for (const node of allNodes) {
        const list = byFile.get(node.fileID) ?? []
        list.push(node)
        byFile.set(node.fileID, list)
      }
      let embedded = 0
      let skipped = 0
      for (const [_fileID, nodes] of byFile) {
        for (const node of nodes) {
          const existing = yield* repo.getEmbedding(node.id)
          if (existing) {
            skipped++
            continue
          }
          yield* embedNode(node).pipe(Effect.catch(() => Effect.void))
          embedded++
        }
      }
      return { embedded, skipped, model }
    })

    return Service.of({ embedAll, embedFile, embedNode })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphRepo.defaultLayer),
  Layer.provide(EmbeddingProvider.defaultLayer),
)
