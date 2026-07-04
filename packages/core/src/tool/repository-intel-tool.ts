export * as RepositoryIntelTool from "./repository-intel-tool"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as repositoryIntelligenceLayer } from "../banyancode/repository-intelligence"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name_find_symbol = "repo_find_symbol"
export const name_find_subsystem = "repo_find_subsystem"
export const name_find_entrypoints = "repo_find_entrypoints"
export const name_find_tests = "repo_find_tests"
export const name_find_related = "repo_find_related"
export const name_estimate_impact = "repo_estimate_impact"
export const name_trace_execution = "repo_trace_execution"

const InputFindSymbol = Schema.Struct({
  name: Schema.String,
  kind: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  exact: Schema.optional(Schema.Boolean),
})

const OutputNodes = Schema.Struct({
  nodes: Schema.Array(CodegraphNodeSchema),
})

const InputFindSubsystem = Schema.Struct({
  query: Schema.String,
  maxDepth: Schema.optional(Schema.Number),
})

const OutputFindSubsystem = Schema.Struct({
  entry: CodegraphNodeSchema,
  related: Schema.Array(CodegraphNodeSchema),
})

const InputFindEntrypoints = Schema.Struct({
  feature: Schema.String,
})

const InputFindTests = Schema.Struct({
  symbol: Schema.String,
})

const InputFindRelated = Schema.Struct({
  nodeID: Schema.String,
  depth: Schema.optional(Schema.Number),
})

const InputEstimateImpact = Schema.Struct({
  paths: Schema.Array(Schema.String),
  maxDepth: Schema.optional(Schema.Number),
})

const OutputEstimateImpact = Schema.Struct({
  direct: Schema.Array(CodegraphNodeSchema),
  transitive: Schema.Array(CodegraphNodeSchema),
  blastRadius: Schema.Number,
})

const InputTraceExecution = Schema.Struct({
  from: Schema.String,
  maxDepth: Schema.optional(Schema.Number),
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const intel = yield* Banyan.RepositoryIntelligence

    yield* tools.register({
      [name_find_symbol]: Tool.make({
        description: "Find symbols in the code graph by name, optionally filtered by kind or file.",
        input: InputFindSymbol,
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `found ${output.nodes.length} symbols` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_symbol, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_symbol,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* intel.findSymbol({
              name: input.name,
              kind: input.kind as Banyan.CodegraphNode["kind"] | undefined,
              file: input.file,
              exact: input.exact,
            })
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "repo_find_symbol failed" }))),
      }),
      [name_find_subsystem]: Tool.make({
        description: "Find a subsystem entry point and related nodes within a depth-bounded neighborhood.",
        input: InputFindSubsystem,
        output: OutputFindSubsystem,
        toModelOutput: ({ output }) => [
          { type: "text", text: `entry=${output.entry.name} related=${output.related.length}` },
        ],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_find_subsystem,
            input,
            (output) => `related=${output.related.length}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_find_subsystem,
                resources: ["*"],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              return yield* intel.findSubsystem({ query: input.query, maxDepth: input.maxDepth })
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repo_find_subsystem failed" }))),
      }),
      [name_find_entrypoints]: Tool.make({
        description: "Find entrypoint functions and classes for a feature by matching file paths.",
        input: InputFindEntrypoints,
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `found ${output.nodes.length} entrypoints` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_entrypoints, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_entrypoints,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* intel.findEntrypoints({ feature: input.feature })
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "repo_find_entrypoints failed" }))),
      }),
      [name_find_tests]: Tool.make({
        description: "Find test nodes that reference the given symbol.",
        input: InputFindTests,
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `found ${output.nodes.length} tests` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_tests, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_tests,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* intel.findTests({ symbol: input.symbol })
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "repo_find_tests failed" }))),
      }),
      [name_find_related]: Tool.make({
        description: "Find nodes related to a given node ID via graph edges within a depth limit.",
        input: InputFindRelated,
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `found ${output.nodes.length} related nodes` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_related, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_related,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* intel.findRelated({ nodeID: input.nodeID, depth: input.depth })
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "repo_find_related failed" }))),
      }),
      [name_estimate_impact]: Tool.make({
        description: "Estimate blast radius for changes to the given file paths.",
        input: InputEstimateImpact,
        output: OutputEstimateImpact,
        toModelOutput: ({ output }) => [
          {
            type: "text",
            text: `direct=${output.direct.length} transitive=${output.transitive.length} blastRadius=${output.blastRadius}`,
          },
        ],
        execute: (input, context) =>
          traced(
            process.cwd(),
            context.sessionID,
            name_estimate_impact,
            input,
            (output) => `blastRadius=${output.blastRadius}`,
            Effect.gen(function* () {
              yield* permission.assert({
                action: name_estimate_impact,
                resources: ["*"],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              return yield* intel.estimateImpact({ paths: [...input.paths], maxDepth: input.maxDepth })
            }),
          ).pipe(Effect.mapError(() => new ToolFailure({ message: "repo_estimate_impact failed" }))),
      }),
      [name_trace_execution]: Tool.make({
        description: "Trace forward execution flow from a node via calls and imports edges.",
        input: InputTraceExecution,
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `trace ${output.nodes.length} nodes` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_trace_execution, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_trace_execution,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* intel.traceExecution({ from: input.from, maxDepth: input.maxDepth })
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "repo_trace_execution failed" }))),
      }),
    })
  }),
).pipe(Layer.provide(repositoryIntelligenceLayer))
