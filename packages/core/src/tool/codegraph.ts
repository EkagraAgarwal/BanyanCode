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
})

export const OutputQuery = Schema.Struct({
  nodes: Schema.Array(Schema.Unknown),
})

export const InputImpact = Schema.Struct({
  nodeID: Schema.String.pipe(Schema.optional),
  function: Schema.String.pipe(Schema.optional),
})

export const OutputImpact = Schema.Struct({
  dependents: Schema.Array(Schema.String),
  transitive: Schema.Array(Schema.String),
})

export const InputDependents = Schema.Struct({
  nodeID: Schema.String.pipe(Schema.optional),
  function: Schema.String.pipe(Schema.optional),
})

export const OutputDependents = Schema.Struct({
  dependents: Schema.Array(Schema.String),
})

export const InputCallers = Schema.Struct({
  nodeID: Schema.String.pipe(Schema.optional),
  function: Schema.String.pipe(Schema.optional),
})

export const OutputCallers = Schema.Struct({
  callers: Schema.Array(Schema.String),
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
          description: "Query the code graph for nodes by file, function name, or kind",
          input: InputQuery,
          output: OutputQuery,
          toModelOutput: ({ output }) => [
            { type: "text", text: `found ${output.nodes.length} nodes` },
          ],
          execute: (input, context) => {
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

              return { nodes }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_query failed` })))
          },
        }),
        [name_impact]: Tool.make({
          description: "Analyze the impact of a node - its dependents and transitive dependencies",
          input: InputImpact,
          output: OutputImpact,
          toModelOutput: ({ output }) => [
            { type: "text", text: `dependents=${output.dependents.length} transitive=${output.transitive.length}` },
          ],
          execute: (input, context) => {
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

              const result = yield* analyzer.impact({ nodeID: input.nodeID, function: input.function })
              return { dependents: result.dependents.map((n) => n.id), transitive: result.transitive.map((n) => n.id) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_impact failed` })))
          },
        }),
        [name_dependents]: Tool.make({
          description: "Find nodes that depend on a given node",
          input: InputDependents,
          output: OutputDependents,
          toModelOutput: ({ output }) => [
            { type: "text", text: `${output.dependents.length} dependents` },
          ],
          execute: (input, context) => {
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
              return { dependents: result.map((n) => n.id) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_dependents failed` })))
          },
        }),
        [name_callers]: Tool.make({
          description: "Find nodes that call a given function",
          input: InputCallers,
          output: OutputCallers,
          toModelOutput: ({ output }) => [
            { type: "text", text: `${output.callers.length} callers` },
          ],
          execute: (input, context) => {
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
              return { callers: result.map((n) => n.id) }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `codegraph_callers failed` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(codegraphAnalyzerLayer), Layer.provide(codegraphBuildServiceLayer))
