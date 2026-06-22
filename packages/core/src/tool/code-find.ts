export * as CodeFindTool from "./code-find"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { CodegraphNodeSchema, GraphMeta } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"
import { cosineSimilarity, decodeStoredEmbedding, keywordSearch } from "./code-embed"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "code_find"

export const Input = Schema.Struct({
  intent: Schema.Literals(["definition", "callers", "dependents", "impact", "semantic", "find_file"]),
  target: Schema.optional(Schema.String),
  minScore: Schema.optional(Schema.Number),
  includeKeywordFallback: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
})

export const Output = Schema.Struct({
  matches: Schema.Array(CodegraphNodeSchema),
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
  hits: Schema.optional(Schema.Array(Schema.Struct({
    node: CodegraphNodeSchema,
    score: Schema.Number,
    source: Schema.Literals(["semantic", "keyword"]),
  }))),
  meta: Schema.optional(GraphMeta),
  intent: Schema.String,
  dispatchedTo: Schema.optional(Schema.String),
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer
    const provider = yield* Banyan.EmbeddingProviderService

    yield* tools.register({
      [name]: Tool.make({
        description:
          "Single entry point for code navigation. Use one of six intents: " +
          "definition (exact symbol/file lookup), callers (who calls this), " +
          "dependents (what this calls/imports), impact (full blast radius), " +
          "semantic (natural-language search), find_file (locate files). " +
          "Returns a meta field with graphVersion/graphCoverage so you can " +
          "reason about graph freshness.",
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [
          { type: "text", text: `intent=${output.intent} dispatched=${output.dispatchedTo ?? "n/a"} matches=${output.matches.length} files=${output.files.length} hits=${output.hits?.length ?? 0}` },
        ],
        execute: (input, context) => {
          const limit = input.limit ?? 50
          return Effect.gen(function* () {
            yield* permission.assert({
              action: name,
              resources: [input.target ?? "*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })

            const metaRow = yield* repo.getMeta()
            const meta = metaRow
              ? {
                  graphBuiltAt: metaRow.graphBuiltAt,
                  graphVersion: metaRow.graphVersion,
                  graphCoverage: metaRow.graphCoverage,
                  totalFiles: metaRow.totalFiles,
                  totalNodes: metaRow.totalNodes,
                  totalEdges: metaRow.totalEdges,
                }
              : undefined

            switch (input.intent) {
              case "definition": {
                const target = input.target ?? ""
                const allNodes = yield* repo.listAllNodes()
                const matches = allNodes.filter((n) => n.name === target || n.code?.includes(target)).slice(0, limit)
                return { matches, files: [], meta, intent: input.intent, dispatchedTo: "codegraph_query" }
              }
              case "callers": {
                const result = yield* analyzer.callers({ function: input.target })
                return { matches: result, files: [], meta, intent: input.intent, dispatchedTo: "codegraph_callers" }
              }
              case "dependents": {
                const result = yield* analyzer.dependents({ function: input.target })
                return { matches: result, files: [], meta, intent: input.intent, dispatchedTo: "codegraph_dependents" }
              }
              case "impact": {
                const result = yield* analyzer.impact({ function: input.target })
                return { matches: result.dependents.slice(0, limit), files: [], meta, intent: input.intent, dispatchedTo: "codegraph_impact" }
              }
              case "semantic": {
                const query = input.target ?? ""
                const minScore = input.minScore ?? 0.2
                const includeKeyword = input.includeKeywordFallback !== false
                const model = yield* provider.model()
                const nodes = yield* repo.listAllNodes()

                type Hit = { node: Banyan.CodegraphNode; score: number; source: "semantic" | "keyword" }
                let hits: Hit[] = []

                if (model) {
                  const embedResult = yield* provider
                    .embed(query)
                    .pipe(Effect.catchCause(() => Effect.succeed(null as Float32Array[] | null)))

                  if (embedResult && embedResult.length > 0) {
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
                      hits = semanticHits
                    } else if (includeKeyword) {
                      hits = keywordSearch(query, nodes, limit).map((node) => ({
                        node,
                        score: 0,
                        source: "keyword" as const,
                      }))
                    }
                  } else if (includeKeyword) {
                    hits = keywordSearch(query, nodes, limit).map((node) => ({
                      node,
                      score: 0,
                      source: "keyword" as const,
                    }))
                  }
                } else if (includeKeyword) {
                  hits = keywordSearch(query, nodes, limit).map((node) => ({
                    node,
                    score: 0,
                    source: "keyword" as const,
                  }))
                }
                return { matches: [], files: [], hits, meta, intent: input.intent, dispatchedTo: "code_search" }
              }
              case "find_file": {
                const target = input.target ?? ""
                const allFiles = yield* repo.listAllFiles()
                const files = allFiles
                  .filter((f) => f.path.includes(target))
                  .slice(0, limit)
                  .map((f) => ({ path: f.path }))
                return { matches: [], files, meta, intent: input.intent, dispatchedTo: "glob" }
              }
            }
          }).pipe(Effect.mapError((err) => {
            if (err instanceof ToolFailure) return err
            return new ToolFailure({ message: `code_find failed for intent=${input.intent}` })
          }))
        },
      }),
    })
  }),
).pipe(Layer.provide(codegraphAnalyzerLayer))
