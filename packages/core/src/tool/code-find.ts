export * as CodeFindTool from "./code-find"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema, GraphMeta } from "../banyancode/types"
import type { CodegraphNode } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"
import { formatNodes } from "./codegraph-format"
import { optionalBoolean, optionalNumber, optionalString } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "code_find"

export const Input = Schema.Struct({
  intent: Schema.Literals(["definition", "callers", "dependents", "impact", "find_file"]).annotate({ description: "The type of search to perform. Start with 'definition' to resolve a node, then use 'callers'/'impact'." }),
  target: optionalString.annotate({ description: "The symbol name, filename, or node ID (UUID:line-line) to search for." }),
  minScore: optionalNumber.annotate({ description: "Minimum score for search results (optional)." }),
  includeKeywordFallback: optionalBoolean.annotate({ description: "Whether to fall back to substring matching if exact symbol name isn't found. Defaults to true." }),
  limit: optionalNumber.annotate({ description: "Maximum number of results to return. Defaults to 50." }),
})

export const Output = Schema.Struct({
  matches: Schema.Array(CodegraphNodeSchema),
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
  meta: Schema.optional(GraphMeta),
  intent: Schema.String,
  dispatchedTo: Schema.optional(Schema.String),
  _diagnostic: Schema.optional(Schema.Literals(["symbol-not-in-graph", "empty-target"])),
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
          "Use when:\n" +
          "  top-level symbol locator across the codebase — routes to the right tool\n" +
          "  based on the `intent` you pass.\n" +
          "Examples\n" +
          "  - \"Find `ToolCatalog`\"\n" +
          "  - \"Where is `SessionTools.resolve`?\"\n" +
          "  - \"Open `ConfigLoader`\"\n" +
          "Returns\n" +
          "  { matches: CodegraphNode[], files: CodegraphFile[], intent: string }\n" +
          "Avoid when\n" +
          "  you have a nodeID — use codegraph_query or repository_query directly.\n" +
          "After this, often: codegraph_callers, codegraph_impact — to traverse from\n" +
          "  the resolved node.\n" +
          "Before this: codegraph_build (if not built).\n" +
          "Note: includeKeywordFallback defaults to true — content-substring matching\n" +
          "  is enabled when the symbol is not found by name. Set to false to opt out.",
        contract: { visibility: "public" },
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => {
          const header = `intent=${output.intent} dispatched=${output.dispatchedTo ?? "n/a"} matches=${output.matches.length} files=${output.files.length}${output._diagnostic ? ` diagnostic=${output._diagnostic}` : ""}`
          const matchesBlock = output.matches.length > 0 ? formatNodes(output.matches, "Matches") : "Matches: none."
          const filesBlock = output.files.length > 0
            ? `Files (${output.files.length}):\n${output.files.map((f) => `  ${f.path}`).join("\n")}`
            : "Files: none."
          return [{ type: "text", text: `${header}\n\n${matchesBlock}\n\n${filesBlock}` }]
        },
        execute: (input, context) => {
          const limit = input.limit ?? 50
          return traced(
            process.cwd(),
            context.sessionID,
            name,
            input,
            (output) => `intent=${output.intent} dispatched=${output.dispatchedTo ?? "n/a"} matches=${output.matches.length} files=${output.files.length}`,
            Effect.gen(function* () {
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
                  if (!target) return { matches: [], files: [], meta, intent: input.intent, dispatchedTo: "codegraph_query" }
                  const allNodes = yield* repo.listAllNodes()
                  const lowerTarget = target.toLowerCase()
                  const allowKeyword = input.includeKeywordFallback !== false

                  let matches: CodegraphNode[]
                  if (allowKeyword) {
                    matches = allNodes.filter((n) =>
                      n.name.toLowerCase() === lowerTarget || (n.code?.toLowerCase().includes(lowerTarget) ?? false)
                    ).slice(0, limit)
                  } else {
                    matches = allNodes.filter((n) => n.name.toLowerCase() === lowerTarget).slice(0, limit)
                  }

                  if (matches.length === 0 && target.includes(".")) {
                    const parts = target.toLowerCase().split(".")
                    const lastPart = parts[parts.length - 1] ?? ""
                    const methodMatches = allNodes.filter((n) => n.name.toLowerCase() === lastPart).slice(0, limit)
                    if (methodMatches.length > 0) matches = methodMatches
                  }

                  return { matches, files: [], meta, intent: input.intent, dispatchedTo: "codegraph_query" }
                }
                case "callers": {
                  if (!input.target) return { matches: [], files: [], meta, intent: input.intent, dispatchedTo: "codegraph_callers", _diagnostic: "empty-target" as const }
                  const isNodeID = /^[0-9a-fA-F\-]{36}:\d+-\d+$/.test(input.target)
                  const arg = isNodeID ? { nodeID: input.target } : { function: input.target }
                  const result = yield* analyzer.callers(arg).pipe(
                    Effect.matchEffect({
                      onFailure: (err) => err._tag === "Banyan/SymbolNotFoundError"
                        ? Effect.succeed<CodegraphNode[]>([])
                        : Effect.fail(err),
                      onSuccess: (nodes) => Effect.succeed(nodes),
                    }),
                  )
                  const isEmpty = result.length === 0
                  return {
                    matches: result,
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_callers",
                    ...(isEmpty ? { _diagnostic: "symbol-not-in-graph" as const } : {}),
                  }
                }
                case "dependents": {
                  if (!input.target) return { matches: [], files: [], meta, intent: input.intent, dispatchedTo: "codegraph_dependents", _diagnostic: "empty-target" as const }
                  const isNodeID = /^[0-9a-fA-F\-]{36}:\d+-\d+$/.test(input.target)
                  const arg = isNodeID ? { nodeID: input.target } : { function: input.target }
                  const result = yield* analyzer.dependents(arg).pipe(
                    Effect.matchEffect({
                      onFailure: (err) => err._tag === "Banyan/SymbolNotFoundError"
                        ? Effect.succeed<CodegraphNode[]>([])
                        : Effect.fail(err),
                      onSuccess: (nodes) => Effect.succeed(nodes),
                    }),
                  )
                  const isEmpty = result.length === 0
                  return {
                    matches: result,
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_dependents",
                    ...(isEmpty ? { _diagnostic: "symbol-not-in-graph" as const } : {}),
                  }
                }
                case "impact": {
                  if (!input.target) return { matches: [], files: [], meta, intent: input.intent, dispatchedTo: "codegraph_impact", _diagnostic: "empty-target" as const }
                  const isNodeID = /^[0-9a-fA-F\-]{36}:\d+-\d+$/.test(input.target)
                  const arg = isNodeID ? { nodeID: input.target } : { function: input.target }
                  const result = yield* analyzer.impact(arg).pipe(
                    Effect.matchEffect({
                      onFailure: (err) => err._tag === "Banyan/SymbolNotFoundError"
                        ? Effect.succeed<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }>({ dependents: [], transitive: [] })
                        : Effect.fail(err),
                      onSuccess: (impact) => Effect.succeed(impact),
                    }),
                  )
                  const isEmpty = result.dependents.length === 0
                  return {
                    matches: result.dependents.slice(0, limit),
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_impact",
                    ...(isEmpty ? { _diagnostic: "symbol-not-in-graph" as const } : {}),
                  }
                }
                case "find_file": {
                  const target = input.target ?? ""
                  if (!target) return { matches: [], files: [], meta, intent: input.intent, dispatchedTo: "codegraph_query", _diagnostic: "empty-target" as const }
                  const allFiles = yield* repo.listAllFiles()
                  const allNodes = yield* repo.listAllNodes()

                  const symbolMatches = allNodes.filter((n) => n.name === target)
                  const graphFileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
                  const graphFiles = allFiles.filter((f) => graphFileIDs.includes(f.id)).map((f) => ({ path: f.path }))

                  let files: { path: string }[]
                  let dispatchedTo: string
                  if (graphFiles.length > 0) {
                    files = graphFiles.slice(0, limit)
                    dispatchedTo = "graph"
                  } else {
                    files = allFiles.filter((f) => f.path.includes(target)).slice(0, limit).map((f) => ({ path: f.path }))
                    dispatchedTo = "glob"
                  }

                  return {
                    matches: symbolMatches.slice(0, limit),
                    files,
                    meta,
                    intent: input.intent,
                    dispatchedTo,
                  }
                }
              }
            }),
          ).pipe(Effect.mapError((err) => {
            if (err instanceof ToolFailure) return err
            return new ToolFailure({ message: `code_find failed for intent=${input.intent}` })
          }))
        },
      }),
    })
  }),
).pipe(Layer.provide(codegraphAnalyzerLayer))
