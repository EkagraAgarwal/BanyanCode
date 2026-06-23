export * as CodegraphEmbedder from "./codegraph-embedder"

import { Cause, Context, Effect, Layer, Schema } from "effect"
import { CodegraphRepo } from "./codegraph-repo"
import { EmbeddingProvider } from "./embedding-provider"
import type { CodegraphNode } from "./types"
import { EventV2 } from "../event"

export const EmbedState = Schema.Struct({
  status: Schema.Literals(["idle", "running", "completed", "failed", "cancelled"]),
  done: Schema.Number,
  total: Schema.Number,
  result: Schema.optional(
    Schema.Struct({
      embedded: Schema.Number,
      skipped: Schema.Number,
    }),
  ),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "Banyan/CodegraphEmbedState" })

export type EmbedState = typeof EmbedState.Type

export const EmbedEvent = EventV2.define({
  type: "banyancode.codeembed.build",
  schema: EmbedState.fields,
})

export interface Interface {
  readonly embedAll: () => Effect.Effect<
    { embedded: number; skipped: number; model: string | undefined },
    EmbeddingProvider.EmbeddingError
  >
  readonly embedFile: (fileID: string) => Effect.Effect<
    { embedded: number; skipped: number; model: string | undefined },
    EmbeddingProvider.EmbeddingError
  >
  readonly embedNode: (node: CodegraphNode) => Effect.Effect<void, EmbeddingProvider.EmbeddingError>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/CodegraphEmbedder") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* CodegraphRepo.Service
    const provider = yield* EmbeddingProvider.EmbeddingProviderService
    const eventBus = yield* EventV2.Service

    const publish = (s: EmbedState) => eventBus.publish(EmbedEvent, s).pipe(Effect.orDie)

    const embedNode = Effect.fn("CodegraphEmbedder.embedNode")(function* (node: CodegraphNode) {
      const text = node.code ?? `${node.name}${node.signature ? " " + node.signature : ""}`
      const embeddings = yield* provider.embed(text)
      const embedding = embeddings[0]
      if (!embedding) {
        return yield* new EmbeddingProvider.EmbeddingError({ message: "Empty embedding result" })
      }
      const model = yield* provider.model()
      if (model === undefined) {
        return yield* new EmbeddingProvider.EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not set" })
      }
      const bytes = new Uint8Array(embedding.buffer)
      yield* repo.putEmbedding(node.id, bytes, model, embedding.length)
      if (process.env.BANYANCODE_DEBUG === "1") {
        console.error(`[turso.vector] putEmbedding node_id=${node.id} dim=${embedding.length} model=${model} bytes=${bytes.byteLength}`)
      }
    })

    const embedFile = Effect.fn("CodegraphEmbedder.embedFile")(function* (fileID: string) {
      const model = yield* provider.model()
      const nodes = yield* repo.listNodesByFile(fileID)
      const total = nodes.length

      if (model === undefined) {
        const err = new EmbeddingProvider.EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not configured. Please select an embedding model in settings." })
        yield* publish({ status: "failed", done: 0, total, error: err.message })
        return yield* Effect.fail(err)
      }

      const initial: EmbedState = { status: "running", done: 0, total }
      yield* publish(initial)

      const run = Effect.gen(function* () {
        let embedded = 0
        let skipped = 0
        let processed = 0
        for (const node of nodes) {
          const existing = yield* repo.getEmbedding(node.id)
          if (existing) {
            skipped++
          } else {
            const success = yield* embedNode(node).pipe(
              Effect.as(true),
              Effect.tapError((err) =>
                Effect.sync(() => {
                  if (process.env.BANYANCODE_DEBUG === "1") {
                    console.error(`[codegraph-embedder] embedNode failed for node ${node.id}:`, err)
                  }
                }),
              ),
              Effect.catchCause(() => Effect.succeed(false)),
            )
            if (success) {
              embedded++
            }
          }
          processed++
          yield* publish({ status: "running", done: processed, total })
        }
        const doneState: EmbedState = {
          status: "completed",
          done: total,
          total,
          result: { embedded, skipped },
        }
        yield* publish(doneState)
        return { embedded, skipped, model }
      })

      return yield* run.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const err = Cause.squash(cause)
            const errorMsg = err instanceof Error ? err.message : String(err)
            yield* publish({ status: "failed", done: 0, total, error: errorMsg })
            return yield* Effect.fail(err as EmbeddingProvider.EmbeddingError)
          }),
        ),
      )
    })

    const embedAll = Effect.fn("CodegraphEmbedder.embedAll")(function* () {
      const allNodes = yield* repo.listAllNodes()
      const total = allNodes.length
      const model = yield* provider.model()

      if (model === undefined) {
        const err = new EmbeddingProvider.EmbeddingError({ message: "BANYANCODE_EMBEDDING_MODEL is not configured. Please select an embedding model in settings." })
        yield* publish({ status: "failed", done: 0, total, error: err.message })
        return yield* Effect.fail(err)
      }

      const initial: EmbedState = { status: "running", done: 0, total }
      yield* publish(initial)

      const run = Effect.gen(function* () {
        const byFile = new Map<string, CodegraphNode[]>()
        for (const node of allNodes) {
          const list = byFile.get(node.fileID) ?? []
          list.push(node)
          byFile.set(node.fileID, list)
        }
        let embedded = 0
        let skipped = 0
        let processed = 0
        for (const [_fileID, nodes] of byFile) {
          for (const node of nodes) {
            const existing = yield* repo.getEmbedding(node.id)
            if (existing) {
              skipped++
            } else {
              const success = yield* embedNode(node).pipe(
                Effect.as(true),
                Effect.tapError((err) =>
                  Effect.sync(() => {
                    if (process.env.BANYANCODE_DEBUG === "1") {
                      console.error(`[codegraph-embedder] embedNode failed for node ${node.id}:`, err)
                    }
                  }),
                ),
                Effect.catchCause(() => Effect.succeed(false)),
              )
              if (success) {
                embedded++
              }
            }
            processed++
            yield* publish({ status: "running", done: processed, total })
          }
        }
        const doneState: EmbedState = {
          status: "completed",
          done: total,
          total,
          result: { embedded, skipped },
        }
        yield* publish(doneState)
        return { embedded, skipped, model }
      })

      return yield* run.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const err = Cause.squash(cause)
            const errorMsg = err instanceof Error ? err.message : String(err)
            yield* publish({ status: "failed", done: 0, total, error: errorMsg })
            return yield* Effect.fail(err as EmbeddingProvider.EmbeddingError)
          }),
        ),
      )
    })

    return Service.of({ embedAll, embedFile, embedNode })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CodegraphRepo.defaultLayer),
  Layer.provide(EmbeddingProvider.defaultLayer),
)
