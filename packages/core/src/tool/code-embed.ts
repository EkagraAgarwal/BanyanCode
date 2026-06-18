export * as CodeEmbedTools from "./code-embed"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name_embed_update = "code_embed_update"
export const name_search = "code_search"

export const InputEmbedUpdate = Schema.Struct({
  file: Schema.String.pipe(Schema.optional),
})

export const OutputEmbedUpdate = Schema.Struct({
  embedded: Schema.Number,
  skipped: Schema.Number,
  model: Schema.NullOr(Schema.String),
})

export const InputSearch = Schema.Struct({
  query: Schema.String,
  limit: Schema.Number.pipe(Schema.optional),
  fileGlob: Schema.String.pipe(Schema.optional),
})

export const OutputSearch = Schema.Struct({
  hits: Schema.Array(
    Schema.Struct({
      node: Schema.Unknown,
      score: Schema.Number,
    }),
  ),
  degraded: Schema.Boolean,
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function keywordSearch(query: string, nodes: Banyan.CodegraphNode[]): Banyan.CodegraphNode[] {
  const lowerQuery = query.toLowerCase()
  return nodes
    .filter((n) => {
      const nameMatch = n.name.toLowerCase().includes(lowerQuery)
      const sigMatch = n.signature?.toLowerCase().includes(lowerQuery) ?? false
      const codeMatch = n.code?.toLowerCase().includes(lowerQuery) ?? false
      return nameMatch || sigMatch || codeMatch
    })
    .slice(0, 10)
}

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const embedder = yield* Banyan.CodegraphEmbedder
    const repo = yield* Banyan.CodegraphRepo
    const provider = yield* Banyan.EmbeddingProviderService

    yield* tools
      .register({
        [name_embed_update]: Tool.make({
          description: "Compute or update embeddings for code graph nodes. Re-embeds only nodes whose content hash has changed.",
          input: InputEmbedUpdate,
          output: OutputEmbedUpdate,
          toModelOutput: ({ output }) => [
            { type: "text", text: `embedded=${output.embedded} skipped=${output.skipped} model=${output.model ?? "none"}` },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_embed_update,
                resources: [input.file ?? "*"],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              let result
              if (input.file) {
                const file = yield* repo.getFileByPath(input.file)
                if (!file) {
                  return yield* Effect.fail(new ToolFailure({ message: `File not found in codegraph: ${input.file}` }))
                }
                result = yield* embedder.embedFile(file.id)
              } else {
                result = yield* embedder.embedAll()
              }

              const model = input.file ? null : (result as { embedded: number; skipped: number; model: string | undefined }).model

              return {
                embedded: result.embedded,
                skipped: result.skipped,
                model: model ?? null,
              }
            }).pipe(
              Effect.mapError((err) => {
                if (err instanceof ToolFailure) return err
                return new ToolFailure({ message: "code_embed_update failed" })
              }),
            )
          },
        }),
        [name_search]: Tool.make({
          description:
            "Search code graph nodes using semantic embedding search when available, falling back to keyword search. Returns degraded=true when embeddings are unavailable.",
          input: InputSearch,
          output: OutputSearch,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.hits.length} hits (degraded=${output.degraded})` },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_search,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              let nodes = yield* repo.listAllNodes()

              if (input.fileGlob) {
                const allFiles = yield* repo.listAllFiles()
                const matchedFiles = allFiles.filter((f) => {
                  const pattern = input.fileGlob!.replace(/\./g, "\\.").replace(/\*/g, ".*")
                  return new RegExp(pattern).test(f.path)
                })
                const matchedFileIDs = new Set(matchedFiles.map((f) => f.id))
                nodes = nodes.filter((n) => matchedFileIDs.has(n.fileID))
              }

              const model = provider.model()

              if (model === undefined) {
                const keywordMatches = keywordSearch(input.query, nodes)
                return {
                  hits: keywordMatches.map((n) => ({ node: n, score: 1 })),
                  degraded: true,
                }
              }

              const embedResult = yield* provider
                .embed(input.query)
                .pipe(
                  Effect.mapError(() => null),
                  Effect.catch(() => Effect.succeed(null)),
                )

              if (!embedResult || embedResult.length === 0) {
                const keywordMatches = keywordSearch(input.query, nodes)
                return {
                  hits: keywordMatches.map((n) => ({ node: n, score: 1 })),
                  degraded: true,
                }
              }

              const queryEmbedding = embedResult[0]

              const scored = yield* Effect.forEach(nodes, (node) =>
                Effect.map(repo.getEmbedding(node.id), (emb) => {
                  if (!emb) return { node, score: 0 }
                  const nodeEmbedding = new Float32Array(new Uint8Array(emb.embedding).buffer)
                  return { node, score: cosineSimilarity(queryEmbedding, nodeEmbedding) }
                }),
              )

              const limit = input.limit ?? 10
              const topResults = scored
                .filter((s) => s.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)

              return {
                hits: topResults.map((s) => ({ node: s.node, score: s.score })),
                degraded: false,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `code_search failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
