export * as CodegraphTools from "./codegraph"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"
import { defaultLayer as codegraphBuildServiceLayer } from "../banyancode/codegraph-build-service"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name_build = "codegraph_build"
export const name_query = "codegraph_query"
export const name_impact = "codegraph_impact"
export const name_dependents = "codegraph_dependents"
export const name_callers = "codegraph_callers"

export const InputBuild = Schema.Struct({
  root: Schema.String.pipe(Schema.optional),
  force: Schema.Boolean.pipe(Schema.optional),
})

export const OutputBuild = Schema.Struct({
  indexed: Schema.Number,
  skipped: Schema.Number,
  duration_ms: Schema.Number,
})

export const InputQuery = Schema.Struct({
  file: Schema.String.pipe(Schema.optional),
  function: Schema.String.pipe(Schema.optional),
  kind: Schema.String.pipe(Schema.optional),
  limit: Schema.Number.pipe(Schema.optional),
})

export const OutputQuery = Schema.Struct({
  nodes: Schema.Array(Schema.Unknown),
})

export const InputImpact = Schema.Struct({
  nodeID: Schema.String.pipe(Schema.optional),
  function: Schema.String.pipe(Schema.optional),
  maxDepth: Schema.Number.pipe(Schema.optional),
  limit: Schema.Number.pipe(Schema.optional),
})

export const OutputImpact = Schema.Struct({
  dependents: Schema.Array(Schema.Unknown),
  transitive: Schema.Array(Schema.Unknown),
})

export const InputDependents = Schema.Struct({
  nodeID: Schema.String.pipe(Schema.optional),
  function: Schema.String.pipe(Schema.optional),
  limit: Schema.Number.pipe(Schema.optional),
})

export const OutputDependents = Schema.Struct({
  dependents: Schema.Array(Schema.Unknown),
})

export const InputCallers = Schema.Struct({
  nodeID: Schema.String.pipe(Schema.optional),
  function: Schema.String.pipe(Schema.optional),
  limit: Schema.Number.pipe(Schema.optional),
})

export const OutputCallers = Schema.Struct({
  callers: Schema.Array(Schema.Unknown),
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
          description: "Build the code graph index for a codebase",
          input: InputBuild,
          output: OutputBuild,
          toModelOutput: ({ output }) => [
            { type: "text", text: `indexed=${output.indexed} skipped=${output.skipped} duration_ms=${output.duration_ms}` },
          ],
          execute: (input, context) => {
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name_build,
                resources: [input.root ?? "*"],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const root = input.root ?? process.cwd()
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
                return {
                  indexed: currentStatus.result.indexed,
                  skipped: currentStatus.result.skipped,
                  duration_ms: currentStatus.result.duration_ms,
                }
              }

              return { indexed: 0, skipped: 0, duration_ms: 0 }
            }).pipe(
              Effect.mapError((err) => {
                if (err instanceof ToolFailure) return err
                return new ToolFailure({ message: "codegraph_build failed" })
              }),
            )
          },
        }),
        [name_query]: Tool.make({
          description:
            "Look up nodes in the code graph. Filter by function name, kind, or file path. " +
            "Returns the matching CodegraphNode objects (with name, kind, signature, file path, line range, code snippet). " +
            "Use this as the primary tool to find symbols when the codegraph is built. " +
            "If the result is empty, the codegraph hasn't been built yet (run /codegraph-build) or the project has no such symbol.",
          input: InputQuery,
          output: OutputQuery,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.nodes.length} nodes` },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 50
            return Effect.gen(function* () {
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

              return { nodes: nodes.slice(0, limit) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_query failed` })))
          },
        }),
        [name_impact]: Tool.make({
          description:
            "Find all nodes affected by a change to the given node. Returns the direct dependents " +
            "(immediate callers) and the transitive closure (everything downstream). " +
            "Use BEFORE making any edit to understand the blast radius. Returns full CodegraphNode objects.",
          input: InputImpact,
          output: OutputImpact,
          toModelOutput: ({ output }) => [
            { type: "text", text: `dependents=${output.dependents.length} transitive=${output.transitive.length}` },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 100
            return Effect.gen(function* () {
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
              return {
                dependents: result.dependents.slice(0, limit),
                transitive: result.transitive.slice(0, limit),
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_impact failed` })))
          },
        }),
        [name_dependents]: Tool.make({
          description:
            "Find nodes that depend on the given node (the reverse: who calls/imports this). " +
            "Returns full CodegraphNode objects. Prefer codegraph_impact for blast-radius analysis " +
            "(it includes transitive closure); use this when you only need the direct callers.",
          input: InputDependents,
          output: OutputDependents,
          toModelOutput: ({ output }) => [
            { type: "text", text: `${output.dependents.length} dependents` },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 50
            return Effect.gen(function* () {
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
              return { dependents: result.slice(0, limit) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_dependents failed` })))
          },
        }),
        [name_callers]: Tool.make({
          description:
            "Find nodes that call the given function. Pass either nodeID (preferred) or function name. " +
            "Returns full CodegraphNode objects with file path and line range so the caller can read or edit them. " +
            "If the codegraph hasn't been built, the response will be empty - fall back to grep for the function name.",
          input: InputCallers,
          output: OutputCallers,
          toModelOutput: ({ output }) => [
            { type: "text", text: `${output.callers.length} callers` },
          ],
          execute: (input, context) => {
            const limit = input.limit ?? 50
            return Effect.gen(function* () {
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
              return { callers: result.slice(0, limit) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_callers failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(codegraphAnalyzerLayer), Layer.provide(codegraphBuildServiceLayer))
