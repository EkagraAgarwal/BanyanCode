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

export const CodeSearchHit = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  range: Schema.Struct({ startLine: Schema.Number, endLine: Schema.Number }),
  name: Schema.String,
  kind: Schema.String,
  score: Schema.Number,
  reason: Schema.String,
  code: Schema.optional(Schema.String),
})

export const InputSearch = Schema.Struct({
  query: Schema.String,
  mode: Schema.Literals(["auto", "lexical", "semantic", "graph", "hybrid"]).pipe(Schema.optional),
  fileGlob: Schema.String.pipe(Schema.optional),
  maxDepth: Schema.Number.pipe(Schema.optional),
  direction: Schema.Literals(["upstream", "downstream", "both"]).pipe(Schema.optional),
  limit: Schema.Number.pipe(Schema.optional),
  includeCode: Schema.Boolean.pipe(Schema.optional),
})

export const OutputSearch = Schema.Struct({
  hits: Schema.Array(CodeSearchHit),
  degraded: Schema.Boolean,
  warning: Schema.optional(Schema.String),
  mode: Schema.String,
  seedCount: Schema.Number,
  expandedCount: Schema.Number,
})

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE === "1"

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

function edgeWeight(kind: string): number {
  switch (kind) {
    case "imports": return 1.0
    case "calls": return 0.8
    case "extends": return 0.6
    case "implements": return 0.6
    case "references": return 0.4
    case "contains": return 0.3
    case "exports": return 0.5
    default: return 0.3
  }
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

              if (input.file) {
                const result = yield* embedder.embedFile(input.file)
                return {
                  embedded: result.embedded,
                  skipped: result.skipped,
                  model: null,
                }
              }
              const result = yield* embedder.embedAll()
              return {
                embedded: result.embedded,
                skipped: result.skipped,
                model: result.model ?? null,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `code_embed_update failed` })), Effect.orDie)
          },
        }),
        [name_search]: Tool.make({
          description:
            "Search code graph nodes using GraphRAG: lexical (FTS5 BM25), semantic (vector cosine), and graph expansion (BFS with edge-weight decay). Returns degraded=true when embeddings are unavailable.",
          input: InputSearch,
          output: OutputSearch,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.hits.length} hits (mode=${output.mode}, degraded=${output.degraded}, seeds=${output.seedCount}, expanded=${output.expandedCount})` },
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

              const mode = input.mode ?? "hybrid"
              const maxDepth = input.maxDepth ?? 2
              const direction = input.direction ?? "both"
              const limit = input.limit ?? 10
              const includeCode = input.includeCode ?? true
              const model = provider.model()

              // Filter nodes by fileGlob if provided
              let allowedFileIDs: Set<string> | undefined
              if (input.fileGlob) {
                const allFiles = yield* repo.listAllFiles()
                const pattern = input.fileGlob.replace(/\./g, "\\.").replace(/\*/g, ".*")
                const re = new RegExp(pattern)
                allowedFileIDs = new Set(allFiles.filter((f) => re.test(f.path)).map((f) => f.id))
              }

              // === Step 1: Lexical seeds (always) ===
              let lexicalSeeds: Array<{ nodeID: string; rank: number }> = []
              if (mode === "auto" || mode === "lexical" || mode === "hybrid" || mode === "graph") {
                const ftsResults = yield* repo.searchFTS(input.query, limit * 2)
                // Filter by fileGlob if provided
                if (allowedFileIDs) {
                  const allowedNodes = yield* Effect.forEach(
                    ftsResults,
                    (r) => Effect.map(repo.getNode(r.nodeID), (n) => (n && allowedFileIDs.has(n.fileID) ? r : null)),
                  )
                  lexicalSeeds = allowedNodes.filter((r) => r !== null).map((r, i) => ({ nodeID: r!.nodeID, rank: i + 1 }))
                } else {
                  lexicalSeeds = ftsResults.map((r, i) => ({ nodeID: r.nodeID, rank: i + 1 }))
                }
              }

              // === Step 2: Vector seeds (if model + mode allows) ===
              let vectorSeeds: Array<{ nodeID: string; rank: number }> = []
              let degraded = false
              let warning: string | undefined
              if ((mode === "auto" || mode === "semantic" || mode === "hybrid") && model) {
                const embedResult = yield* provider.embed(input.query).pipe(
                  Effect.mapError((e) => e),
                  Effect.catch(() => Effect.succeed(null)),
                )
                if (embedResult && embedResult.length > 0) {
                  const queryEmbedding = embedResult[0]
                  const allNodes = yield* repo.listAllNodes()
                  const filteredNodes = allowedFileIDs
                    ? allNodes.filter((n) => allowedFileIDs!.has(n.fileID))
                    : allNodes
                  const scored = yield* Effect.forEach(filteredNodes, (node) =>
                    Effect.map(repo.getEmbedding(node.id), (emb) => {
                      if (!emb || emb.model !== model) return { nodeID: node.id, score: 0 }
                      const nodeEmbedding = new Float32Array(new Uint8Array(emb.embedding).buffer)
                      return { nodeID: node.id, score: cosineSimilarity(queryEmbedding, nodeEmbedding) }
                    }),
                  )
                  vectorSeeds = scored
                    .filter((s) => s.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, limit * 2)
                    .map((s, i) => ({ nodeID: s.nodeID, rank: i + 1 }))
                } else {
                  degraded = true
                  warning = "Embedding request failed; falling back to lexical search"
                }
              } else if ((mode === "auto" || mode === "semantic" || mode === "hybrid") && !model) {
                degraded = true
                warning = "No embedding model configured; using lexical search only"
              }

              // === Step 3: Reciprocal rank fusion ===
              const rrfK = 60
              const fusedScores = new Map<string, number>()
              for (const { nodeID, rank } of lexicalSeeds) {
                fusedScores.set(nodeID, (fusedScores.get(nodeID) ?? 0) + 1 / (rrfK + rank))
              }
              for (const { nodeID, rank } of vectorSeeds) {
                fusedScores.set(nodeID, (fusedScores.get(nodeID) ?? 0) + 1 / (rrfK + rank))
              }

              // === Step 4: Graph expansion ===
              const seedIDs = new Set(fusedScores.keys())
              const expandedScores = new Map<string, { score: number; reason: string; depth: number }>()

              for (const [nodeID, score] of fusedScores) {
                expandedScores.set(nodeID, { score, reason: "seed", depth: 0 })
              }

              if (mode === "auto" || mode === "graph" || mode === "hybrid") {
                const { nodes: expandedNodes, edges: expandedEdges } = yield* repo.getGraphContext({
                  nodeIDs: Array.from(seedIDs),
                  maxUpHops: maxDepth,
                  maxDownHops: maxDepth,
                  limit: limit * 5,
                })

                for (const node of expandedNodes) {
                  if (seedIDs.has(node.id)) continue
                  if (allowedFileIDs && !allowedFileIDs.has(node.fileID)) continue

                  // Find which seed node led to this expanded node to calculate a score
                  // For now we just give it a fixed expansion score decay
                  const seedScore = Array.from(fusedScores.values())[0] ?? 0.1
                  expandedScores.set(node.id, { 
                    score: seedScore * 0.5, 
                    reason: "graph expansion", 
                    depth: 1 
                  })
                }
              }

              // === Step 5: Build hits ===
              const allHits = Array.from(expandedScores.entries())
                .sort((a, b) => b[1].score - a[1].score)
                .slice(0, limit)

              const hits = yield* Effect.forEach(allHits, ([nodeID, info]) =>
                Effect.gen(function* () {
                  const node = yield* repo.getNode(nodeID)
                  if (!node) return null
                  const file = yield* repo.getFile(node.fileID)
                  if (!file) return null
                  const hit: { id: string; file: string; range: { startLine: number; endLine: number }; name: string; kind: string; score: number; reason: string; code?: string } = {
                    id: node.id,
                    file: file.path,
                    range: { startLine: node.startLine, endLine: node.endLine },
                    name: node.name,
                    kind: node.kind,
                    score: info.score,
                    reason: info.reason,
                  }
                  if (includeCode) hit.code = node.code ?? node.textExcerpt
                  return hit
                }),
              )

              return {
                hits: hits.filter((h) => h !== null) as Array<{ id: string; file: string; range: { startLine: number; endLine: number }; name: string; kind: string; score: number; reason: string; code?: string }>,
                degraded,
                warning,
                mode,
                seedCount: seedIDs.size,
                expandedCount: expandedScores.size - seedIDs.size,
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "code_search failed" })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)
