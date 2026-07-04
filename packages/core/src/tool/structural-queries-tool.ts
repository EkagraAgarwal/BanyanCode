export * as StructuralQueriesTool from "./structural-queries-tool"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as structuralQueriesLayer } from "../banyancode/structural-queries"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name_find_implementations = "codegraph_find_implementations"
export const name_find_overrides = "codegraph_find_overrides"
export const name_find_recursive = "codegraph_find_recursive"
export const name_find_async = "codegraph_find_async"
export const name_find_http_routes = "codegraph_find_http_routes"

const OutputNodes = Schema.Struct({
  nodes: Schema.Array(CodegraphNodeSchema),
})

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const queries = yield* Banyan.StructuralQueries

    yield* tools.register({
      [name_find_implementations]: Tool.make({
        description: "Find classes that implement or extend the given interface or base class name.",
        input: Schema.Struct({
          interfaceName: Schema.String,
          file: Schema.optional(Schema.String),
          language: Schema.optional(Schema.String),
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `${output.nodes.length} implementations` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_implementations, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_implementations,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* queries.findImplementations(input)
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "codegraph_find_implementations failed" }))),
      }),
      [name_find_overrides]: Tool.make({
        description: "Find method overrides with the given method name.",
        input: Schema.Struct({
          methodName: Schema.String,
          baseClass: Schema.optional(Schema.String),
          file: Schema.optional(Schema.String),
          language: Schema.optional(Schema.String),
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `${output.nodes.length} overrides` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_overrides, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_overrides,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* queries.findOverrides(input)
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "codegraph_find_overrides failed" }))),
      }),
      [name_find_recursive]: Tool.make({
        description: "Find recursive functions in the indexed codebase.",
        input: Schema.Struct({
          file: Schema.optional(Schema.String),
          language: Schema.optional(Schema.String),
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `${output.nodes.length} recursive functions` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_recursive, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_recursive,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* queries.findRecursiveFunctions(input)
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "codegraph_find_recursive failed" }))),
      }),
      [name_find_async]: Tool.make({
        description: "Find async functions in the indexed codebase.",
        input: Schema.Struct({
          file: Schema.optional(Schema.String),
          language: Schema.optional(Schema.String),
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `${output.nodes.length} async functions` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_async, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_async,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* queries.findAsyncFunctions(input)
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "codegraph_find_async failed" }))),
      }),
      [name_find_http_routes]: Tool.make({
        description: "Find HTTP route registrations (Express/Fastify style) in the indexed codebase.",
        input: Schema.Struct({
          file: Schema.optional(Schema.String),
          language: Schema.optional(Schema.String),
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [{ type: "text", text: `${output.nodes.length} routes` }],
        execute: (input, context) =>
          traced(process.cwd(), context.sessionID, name_find_http_routes, input, (output) => `nodes=${output.nodes.length}`, Effect.gen(function* () {
            yield* permission.assert({
              action: name_find_http_routes,
              resources: ["*"],
              save: ["*"],
              metadata: input,
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            const nodes = yield* queries.findHTTPRoutes(input)
            return { nodes }
          })).pipe(Effect.mapError(() => new ToolFailure({ message: "codegraph_find_http_routes failed" }))),
      }),
    })
  }),
).pipe(Layer.provide(structuralQueriesLayer))
