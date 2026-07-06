export * as CodegraphTools from "./codegraph"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema, GraphMeta } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"
import { defaultLayer as codegraphBuildServiceLayer } from "../banyancode/codegraph-build-service"
import { formatNodes } from "./codegraph-format"
import { optionalBoolean, optionalNumber, optionalString } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir)
  const { root: fsRoot } = path.parse(dir)
  
  // First pass: look specifically for .git to find the true workspace/monorepo root
  let current = dir
  while (current !== fsRoot) {
    if (existsSync(path.join(current, ".git"))) {
      return current
    }
    current = path.dirname(current)
  }
  
  // Second pass: fallback to package.json if not a git repository
  current = dir
  while (current !== fsRoot) {
    if (existsSync(path.join(current, "package.json"))) {
      return current
    }
    current = path.dirname(current)
  }
  
  return undefined
}

export const name_build = "codegraph_build"
export const name_query = "codegraph_query"
export const name_impact = "codegraph_impact"
export const name_dependents = "codegraph_dependents"
export const name_callers = "codegraph_callers"

export const InputBuild = Schema.Struct({
  root: optionalString,
  force: optionalBoolean,
})

export const OutputBuild = Schema.Struct({
  indexed: Schema.Number,
  skipped: Schema.Number,
  duration_ms: Schema.Number,
  symbolsIndexed: Schema.Number,
  skippedByReason: Schema.Struct({
    gitignored: Schema.Number,
    banyanignored: Schema.Number,
    artifact: Schema.Number,
    tooLarge: Schema.Number,
    minified: Schema.Number,
    tooLargeParse: Schema.Number,
    cached: Schema.Number,
    readError: Schema.Number,
    parseFailure: Schema.Number,
  }),
  parseErrors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        cause: Schema.String,
        indexedAt: Schema.Number,
      }),
    ),
  ),
  meta: Schema.optional(GraphMeta),
})

export const InputQuery = Schema.Struct({
  file: optionalString,
  function: optionalString,
  kind: optionalString,
  limit: optionalNumber,
})

export const OutputQuery = Schema.Struct({
  nodes: Schema.Array(CodegraphNodeSchema),
  meta: Schema.optional(GraphMeta),
})

export const InputImpact = Schema.Struct({
  nodeID: optionalString,
  function: optionalString,
  maxDepth: optionalNumber,
  limit: optionalNumber,
})

export const OutputImpact = Schema.Struct({
  dependents: Schema.Array(CodegraphNodeSchema),
  transitive: Schema.Array(CodegraphNodeSchema),
  meta: Schema.optional(GraphMeta),
})

export const InputDependents = Schema.Struct({
  nodeID: optionalString,
  function: optionalString,
  limit: optionalNumber,
})

export const OutputDependents = Schema.Struct({
  dependents: Schema.Array(CodegraphNodeSchema),
  meta: Schema.optional(GraphMeta),
})

export const InputCallers = Schema.Struct({
  nodeID: optionalString,
  function: optionalString,
  limit: optionalNumber,
})

export const OutputCallers = Schema.Struct({
  callers: Schema.Array(CodegraphNodeSchema),
  meta: Schema.optional(GraphMeta),
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const buildService = yield* Banyan.CodegraphBuildService
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer

    yield* tools
      .register({
        [name_build]: Tool.make({
          description:
            "Use when:\n" +
            "  building the code graph from scratch, refreshing a stale index, or the user\n" +
            "  explicitly says 'build' / 'rebuild' / 'index'.\n" +
            "Examples\n" +
            '  - "Build the code graph"\n' +
            '  - "Rebuild the index after editing many files"\n' +
            '  - "Index this codebase"\n' +
            "Returns\n" +
            "  { indexed, skipped, skippedByReason: { gitignored, banyanignored, artifact,\n" +
            "    tooLarge, minified, tooLargeParse, cached, readError, parseFailure } (9 buckets),\n" +
            "    parseErrors: [{ path, cause, indexedAt }], symbolsIndexed, duration_ms,\n" +
            "    meta: { graphVersion, graphCoverage, totalFiles, totalNodes, totalEdges } }\n" +
            "Avoid when\n" +
            "  the index is fresh — query first via codegraph_query or repository_query.\n" +
            "After this, often: codegraph_query or repository_query — to read the graph.\n" +
            "Before this: none — this is a top-level operation.",
          contract: { visibility: "public" },
          input: InputBuild,
          output: OutputBuild,
          toModelOutput: ({ output }) => {
            const r = output.skippedByReason ?? {
              gitignored: 0, banyanignored: 0, artifact: 0,
              tooLarge: 0, minified: 0, tooLargeParse: 0,
              cached: 0, readError: 0, parseFailure: 0,
            }
            const parseErrorCount = output.parseErrors?.length ?? 0
            const lines = [
              `indexed=${output.indexed} skipped=${output.skipped}`,
              `skippedByReason.gitignored=${r.gitignored} banyanignored=${r.banyanignored} artifact=${r.artifact}`,
              `skippedByReason.tooLarge=${r.tooLarge} minified=${r.minified} tooLargeParse=${r.tooLargeParse}`,
              `skippedByReason.cached=${r.cached} readError=${r.readError} parseFailure=${r.parseFailure}`,
              `parseErrors.length=${parseErrorCount}`,
              `symbolsIndexed=${output.symbolsIndexed} duration_ms=${output.duration_ms}`,
            ]
            if (output.meta) {
              const m = output.meta
              lines.push(
                `meta.graphVersion=${m.graphVersion} meta.graphCoverage=${m.graphCoverage?.toFixed(4) ?? "n/a"} meta.totalFiles=${m.totalFiles} meta.totalNodes=${m.totalNodes} meta.totalEdges=${m.totalEdges}`
              )
            }
            return [{ type: "text", text: lines.join("\n") }]
          },
          execute: (input, context) => {
            return traced(
              process.cwd(),
              context.sessionID,
              name_build,
              input,
              (output) => `indexed=${output.indexed} skipped=${output.skipped} symbols=${output.symbolsIndexed} duration_ms=${output.duration_ms}`,
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name_build,
                  resources: [input.root ?? "*"],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })

                let resolvedRoot: string | undefined = input.root
                if (!resolvedRoot) {
                  const ws = findRepoRoot(process.cwd())
                  if (ws) {
                    resolvedRoot = ws
                    yield* Effect.logWarning(
                      `codegraph_build: input.root not provided; walked up from CWD to repo root: ${ws}`,
                    )
                  } else {
                    yield* Effect.logWarning(
                      `codegraph_build: input.root not provided and no .git/package.json marker found from CWD ${process.cwd()}; falling back to process.cwd()`,
                    )
                  }
                }
                const root = path.resolve(resolvedRoot ?? process.cwd())
                yield* buildService.start({ root, force: input.force ?? false })

                let currentStatus = yield* buildService.status()
                while (currentStatus.status === "running") {
                  yield* Effect.sleep("500 millis")
                  currentStatus = yield* buildService.status()
                }

                if (currentStatus.status === "failed") {
                  return yield* Effect.fail(
                    new ToolFailure({
                      message: `codegraph_build failed: ${currentStatus.error ?? "unknown error"}`,
                    }),
                  )
                }

                if (currentStatus.status === "cancelled") {
                  return yield* Effect.fail(
                    new ToolFailure({
                      message: "codegraph_build was cancelled",
                    }),
                  )
                }

                if (currentStatus.status === "completed" && currentStatus.result) {
                  const meta = yield* repo.getMeta()
                  const indexerResult = currentStatus.result
                  return {
                    indexed: indexerResult.indexed,
                    skipped: indexerResult.skipped,
                    duration_ms: indexerResult.duration_ms,
                    symbolsIndexed: indexerResult.symbolsIndexed,
                    skippedByReason: indexerResult.skippedByReason,
                    parseErrors: (indexerResult as { parseErrors?: Array<{ path: string; cause: string; indexedAt: number }> }).parseErrors ?? [],
                    meta: meta
                      ? {
                          graphBuiltAt: meta.graphBuiltAt,
                          graphVersion: meta.graphVersion,
                          graphCoverage: meta.graphCoverage,
                          totalFiles: meta.totalFiles,
                          totalNodes: meta.totalNodes,
                          totalEdges: meta.totalEdges,
                        }
                      : undefined,
                  }
                }

                return {
                  indexed: 0,
                  skipped: 0,
                  duration_ms: 0,
                  symbolsIndexed: 0,
                  skippedByReason: {
                    gitignored: 0,
                    banyanignored: 0,
                    artifact: 0,
                    tooLarge: 0,
                    minified: 0,
                    tooLargeParse: 0,
                    cached: 0,
                    readError: 0,
                    parseFailure: 0,
                  },
                  parseErrors: [],
                  meta: undefined,
                }
              }),
            ).pipe(
              Effect.mapError((err) => {
                if (err instanceof ToolFailure) return err
                return new ToolFailure({ message: "codegraph_build failed" })
              }),
            )
          },
        }),
        [name_query]: Tool.make({
          description:
            "Use when:\n" +
            "  looking up symbol(s) by name, file, or kind in the code graph (graph-level\n" +
            "  lookup; not user-facing semantic search).\n" +
            "Examples\n" +
            "  - \"Where is `ToolCatalog` defined?\"\n" +
            "  - \"List all `function` nodes in `src/`\"\n" +
            "  - \"Find all symbols named `parse`\"\n" +
            "Returns\n" +
            "  { nodes: CodegraphNode[], meta: { graphBuiltAt, graphVersion, graphCoverage,\n" +
            "    totalNodes, totalEdges } }\n" +
            "Avoid when\n" +
            "  the user gave an exact file path — use read; or for semantic repository\n" +
            "  questions — prefer repository_query.\n" +
            "After this, often: codegraph_callers, codegraph_dependents, codegraph_impact,\n" +
            "  repository_trace, repository_impact — to traverse the graph.\n" +
            "Before this: codegraph_build (if not built), repository_query (if unsure).",
          contract: { visibility: "internal" },
          input: InputQuery,
          output: OutputQuery,
          toModelOutput: ({ output }) => [
            { type: "text", text: formatNodes(output.nodes, "Query results") },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 50
            return traced(
              process.cwd(),
              context.sessionID,
              name_query,
              input,
              (output) => `nodes=${output.nodes.length}`,
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name_query,
                  resources: ["*"],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })

                let nodes: Banyan.CodegraphNode[] = []

                if (input.function) {
                  const allNodes = yield* repo.listAllNodes()
                  nodes = allNodes.filter((n) => n.name === input.function)
                } else if (input.kind) {
                  const allNodes = yield* repo.listAllNodes()
                  nodes = allNodes.filter((n) => n.kind === input.kind)
                } else if (input.file) {
                  const file = yield* repo.getFileByPath(input.file)
                  if (file) {
                    nodes = yield* repo.listNodesByFile(file.id)
                  }
                } else {
                  nodes = yield* repo.listAllNodes()
                }

                const meta = yield* repo.getMeta()
                return {
                  nodes: nodes.slice(0, limit),
                  meta: meta
                    ? {
                        graphBuiltAt: meta.graphBuiltAt,
                        graphVersion: meta.graphVersion,
                        graphCoverage: meta.graphCoverage,
                        totalFiles: meta.totalFiles,
                        totalNodes: meta.totalNodes,
                        totalEdges: meta.totalEdges,
                      }
                    : undefined,
                }
              }),
            ).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_query failed` })))
          },
        }),
        [name_impact]: Tool.make({
          description:
            "Use when:\n" +
            "  full blast-radius analysis — direct AND transitive dependents of a node.\n" +
            "Examples\n" +
            "  - \"What breaks if I change `MemoryRepo`?\"\n" +
            "Returns\n" +
            "  { dependents: CodegraphNode[], transitive: CodegraphNode[], meta: { ... } }\n" +
            "Avoid when\n" +
            "  you only need direct callers/dependents — codegraph_callers or\n" +
            "  codegraph_dependents is cheaper.\n" +
            "After this, often: repository_impact, edit_plan — to plan an edit.\n" +
            "Before this: codegraph_query (to find nodeID), codegraph_build (if not built).",
          contract: { visibility: "advanced" },
          input: InputImpact,
          output: OutputImpact,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: `${formatNodes(output.dependents, "Direct dependents")}\n${formatNodes(output.transitive, "Transitive dependents")}`,
            },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 100
            return traced(
              process.cwd(),
              context.sessionID,
              name_impact,
              input,
              (output) => `dependents=${output.dependents.length} transitive=${output.transitive.length}`,
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name_impact,
                  resources: ["*"],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })

                const result = yield* analyzer.impact({
                  nodeID: input.nodeID,
                  function: input.function,
                })
                const meta = yield* repo.getMeta()
                return {
                  dependents: result.dependents.slice(0, limit),
                  transitive: result.transitive.slice(0, limit),
                  meta: meta
                    ? {
                        graphBuiltAt: meta.graphBuiltAt,
                        graphVersion: meta.graphVersion,
                        graphCoverage: meta.graphCoverage,
                        totalFiles: meta.totalFiles,
                        totalNodes: meta.totalNodes,
                        totalEdges: meta.totalEdges,
                      }
                    : undefined,
                }
              }),
            ).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_impact failed` })))
          },
        }),
        [name_dependents]: Tool.make({
          description:
            "Use when:\n" +
            "  finding direct dependents (who calls/imports a given node) — graph-level.\n" +
            "Examples\n" +
            "  - \"What depends on `Repository`?\"\n" +
            "  - \"Who imports `SessionProcessor`?\"\n" +
            "Returns\n" +
            "  { dependents: CodegraphNode[], meta: { ... } }\n" +
            "Avoid when\n" +
            "  you want transitive blast radius — use codegraph_impact.\n" +
            "After this, often: codegraph_impact — for transitive reach.\n" +
            "Before this: codegraph_query (to find nodeID).",
          contract: { visibility: "internal" },
          input: InputDependents,
          output: OutputDependents,
          toModelOutput: ({ output }) => [
            { type: "text", text: formatNodes(output.dependents, "Dependents") },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 50
            return traced(
              process.cwd(),
              context.sessionID,
              name_dependents,
              input,
              (output) => `dependents=${output.dependents.length}`,
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name_dependents,
                  resources: ["*"],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })

                const result = yield* analyzer.dependents({ nodeID: input.nodeID, function: input.function })
                const meta = yield* repo.getMeta()
                return {
                  dependents: result.slice(0, limit),
                  meta: meta
                    ? {
                        graphBuiltAt: meta.graphBuiltAt,
                        graphVersion: meta.graphVersion,
                        graphCoverage: meta.graphCoverage,
                        totalFiles: meta.totalFiles,
                        totalNodes: meta.totalNodes,
                        totalEdges: meta.totalEdges,
                      }
                    : undefined,
                }
              }),
            ).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_dependents failed` })))
          },
        }),
        [name_callers]: Tool.make({
          description:
            "Use when:\n" +
            "  finding what calls a function (graph-level reverse lookup).\n" +
            "Examples\n" +
            "  - \"Who calls `parse()`?\"\n" +
            "  - \"What invokes `execute()`?\"\n" +
            "Returns\n" +
            "  { callers: CodegraphNode[], meta: { ... } }\n" +
            "Avoid when\n" +
            "  you want transitive dependents — use codegraph_impact.\n" +
            "After this, often: repository_impact, edit_plan — to plan around the callers.\n" +
            "Before this: codegraph_query (to find nodeID).",
          contract: { visibility: "internal" },
          input: InputCallers,
          output: OutputCallers,
          toModelOutput: ({ output }) => [
            { type: "text", text: formatNodes(output.callers, "Callers") },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 50
            return traced(
              process.cwd(),
              context.sessionID,
              name_callers,
              input,
              (output) => `callers=${output.callers.length}`,
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name_callers,
                  resources: ["*"],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })

                const result = yield* analyzer.callers({ nodeID: input.nodeID, function: input.function })
                const meta = yield* repo.getMeta()
                return {
                  callers: result.slice(0, limit),
                  meta: meta
                    ? {
                        graphBuiltAt: meta.graphBuiltAt,
                        graphVersion: meta.graphVersion,
                        graphCoverage: meta.graphCoverage,
                        totalFiles: meta.totalFiles,
                        totalNodes: meta.totalNodes,
                        totalEdges: meta.totalEdges,
                      }
                    : undefined,
                }
              }),
            ).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_callers failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(codegraphAnalyzerLayer), Layer.provide(codegraphBuildServiceLayer))
