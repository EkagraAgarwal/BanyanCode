export * as CodeFindTool from "./code-find"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { CodegraphNodeSchema, GraphMeta } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "code_find"

export const Input = Schema.Struct({
  intent: Schema.Literals(["definition", "callers", "dependents", "impact", "find_file"]),
  target: Schema.optional(Schema.String),
  minScore: Schema.optional(Schema.Number),
  includeKeywordFallback: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
})

export const Output = Schema.Struct({
  matches: Schema.Array(CodegraphNodeSchema),
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
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

    yield* tools.register({
      [name]: Tool.make({
        description:
          "Single entry point for code navigation. Use one of five intents: " +
          "definition (exact symbol/file lookup), callers (who calls this), " +
          "dependents (what this calls/imports), impact (full blast radius), " +
          "find_file (locate files). " +
          "Returns a meta field with graphVersion/graphCoverage so you can " +
          "reason about graph freshness.",
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [
          { type: "text", text: `intent=${output.intent} dispatched=${output.dispatchedTo ?? "n/a"} matches=${output.matches.length} files=${output.files.length}` },
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
