export * as CodeEmbedTools from "./code-embed"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name_embed_update = "code_embed_update"
export const name_search = "code_search"

const CodegraphNodeSchema = Schema.Struct({
  id: Schema.String,
  fileID: Schema.String,
  kind: Schema.Literals(["file", "function", "class", "method", "type", "variable"]),
  name: Schema.String,
  signature: Schema.optional(Schema.String),
  startLine: Schema.Number,
  endLine: Schema.Number,
  code: Schema.optional(Schema.String),
})

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
  minScore: Schema.Number.pipe(Schema.optional),
  fileGlob: Schema.String.pipe(Schema.optional),
  includeKeywordFallback: Schema.Boolean.pipe(Schema.optional),
})

export const OutputSearch = Schema.Struct({
  hits: Schema.Array(
    Schema.Struct({
      node: CodegraphNodeSchema,
      score: Schema.Number,
      source: Schema.Literals(["semantic", "keyword"]),
    }),
  ),
  degraded: Schema.Boolean,
  totalCandidates: Schema.Number,
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

const DEFAULT_LIMIT = 10
const DEFAULT_MIN_SCORE = 0.2

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function decodeStoredEmbedding(raw: Uint8Array, dim: number): Float32Array {
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  return new Float32Array(buffer)
}

function keywordSearch(
  query: string,
  nodes: readonly Banyan.CodegraphNode[],
  limit: number,
): Banyan.CodegraphNode[] {
  const lowerQuery = query.toLowerCase()
  const scored = nodes
    .map((n) => {
      const nameMatch = n.name.toLowerCase().includes(lowerQuery)
      const sigMatch = n.signature?.toLowerCase().includes(lowerQuery) ?? false
      const codeMatch = n.code?.toLowerCase().includes(lowerQuery) ?? false
      const matched = nameMatch || sigMatch || codeMatch
      const nameExact = n.name.toLowerCase() === lowerQuery
      const score = nameExact ? 1 : matched ? 0.5 : 0
      return { node: n, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
  return scored.slice(0, limit).map((s) => s.node)
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
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
          description:
            "Compute or update embeddings for code graph nodes. Re-embeds only nodes whose content hash has changed. " +
            "Requires /codegraph-build to have been run first, and an embedding model configured via banyancode_embedding_model.",
          input: InputEmbedUpdate,
          output: OutputEmbedUpdate,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `embedded=${output.embedded} skipped=${output.skipped} model=${output.model ?? "none"}`,
            },
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
                return {
                  embedded: result.embedded,
                  skipped: result.skipped,
                  model: provider.model() ?? null,
                }
              }

              result = yield* embedder.embedAll()
              return {
                embedded: result.embedded,
                skipped: result.skipped,
                model: result.model ?? null,
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
            "Primary search tool for the code graph. Uses semantic embeddings when available, with a keyword fallback. " +
            "Pass fileGlob to scope results to a file pattern. Returns hits with score, kind, file, and line range so the " +
            "caller can read the file or follow up with codegraph_callers / codegraph_impact. " +
            "If the response is degraded=true, no embedding model is configured; install one via /embedding-model and " +
            "run /code-embed for full semantic search.",
          input: InputSearch,
          output: OutputSearch,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `found ${output.hits.length} hits (candidates=${output.totalCandidates} degraded=${output.degraded})`,
            },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? DEFAULT_LIMIT
            const minScore = input.minScore ?? DEFAULT_MIN_SCORE
            const includeKeyword = input.includeKeywordFallback ?? true

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
                const re = globToRegex(input.fileGlob)
                const matchedFileIDs = new Set(
                  allFiles.filter((f) => re.test(f.path)).map((f) => f.id),
                )
                nodes = nodes.filter((n) => matchedFileIDs.has(n.fileID))
              }

              const totalCandidates = nodes.length
              const model = provider.model()

              if (model === undefined) {
                const keywordMatches = includeKeyword ? keywordSearch(input.query, nodes, limit) : []
                return {
                  hits: keywordMatches.map((n) => ({ node: n, score: 0, source: "keyword" as const })),
                  degraded: true,
                  totalCandidates,
                }
              }

              const embedResult = yield* provider
                .embed(input.query)
                .pipe(Effect.catchCause(() => Effect.succeed(null as Float32Array[] | null)))

              if (!embedResult || embedResult.length === 0) {
                const keywordMatches = includeKeyword ? keywordSearch(input.query, nodes, limit) : []
                return {
                  hits: keywordMatches.map((n) => ({ node: n, score: 0, source: "keyword" as const })),
                  degraded: true,
                  totalCandidates,
                }
              }

              const queryEmbedding = embedResult[0]

              const scored = yield* Effect.forEach(nodes, (node) =>
                Effect.map(repo.getEmbedding(node.id), (emb) => {
                  if (!emb) return { node, score: 0 }
                  const nodeEmbedding = decodeStoredEmbedding(emb.embedding, emb.dim)
                  return { node, score: cosineSimilarity(queryEmbedding, nodeEmbedding) }
                }),
              )

              const semanticHits = scored
                .filter((s) => s.score >= minScore)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map((s) => ({ node: s.node, score: s.score, source: "semantic" as const }))

              if (semanticHits.length > 0) {
                return {
                  hits: semanticHits,
                  degraded: false,
                  totalCandidates,
                }
              }

              if (includeKeyword) {
                const keywordMatches = keywordSearch(input.query, nodes, limit)
                return {
                  hits: keywordMatches.map((n) => ({ node: n, score: 0, source: "keyword" as const })),
                  degraded: true,
                  totalCandidates,
                }
              }

              return {
                hits: [],
                degraded: false,
                totalCandidates,
              }
            }).pipe(Effect.mapError((err) => {
              if (err instanceof ToolFailure) return err
              return new ToolFailure({ message: `code_search failed: ${err instanceof Error ? err.message : String(err)}` })
            }))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)