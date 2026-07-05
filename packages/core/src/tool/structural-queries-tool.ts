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
import { formatNodes } from "./codegraph-format"
import { optionalString } from "./tool-schema"

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
        description:
          "Use when:\n" +
          "  structural queries — find classes that implement or extend an interface/base.\n" +
          "Examples\n" +
          "  - \"Find implementations of `Repository`\"\n" +
          "  - \"Classes that extend `BaseService`\"\n" +
          "Returns\n" +
          "  { nodes: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  you want callers/dependents/impact — those are different tools.\n" +
          "After this, often: repository_explain — to read the most-used implementation.\n" +
          "Before this: codegraph_build (if not built).",
        contract: { visibility: "internal" },
        input: Schema.Struct({
          interfaceName: Schema.String,
          file: optionalString,
          language: optionalString,
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [
          { type: "text", text: formatNodes(output.nodes, "Implementations") },
        ],
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
        description:
          "Use when:\n" +
          "  structural queries — find method overrides by name across subclasses.\n" +
          "Examples\n" +
          "  - \"Find all `parse()` overrides\"\n" +
          "Returns\n" +
          "  { nodes: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  you want callers/dependents/impact — those are different tools.\n" +
          "After this, often: repository_explain — to compare override behavior.\n" +
          "Before this: codegraph_build (if not built).",
        contract: { visibility: "internal" },
        input: Schema.Struct({
          methodName: Schema.String,
          baseClass: optionalString,
          file: optionalString,
          language: optionalString,
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [
          { type: "text", text: formatNodes(output.nodes, "Overrides") },
        ],
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
        description:
          "Use when:\n" +
          "  structural queries — find recursive functions in the indexed codebase.\n" +
          "Examples\n" +
          "  - \"List all recursive functions\"\n" +
          "Returns\n" +
          "  { nodes: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  you want callers/dependents/impact — those are different tools.\n" +
          "Use repository_query instead — the harness delegates this query when needed.",
        contract: { visibility: "internal" },
        input: Schema.Struct({
          file: optionalString,
          language: optionalString,
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [
          { type: "text", text: formatNodes(output.nodes, "Recursive functions") },
        ],
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
        description:
          "Use when:\n" +
          "  structural queries — find `async` functions in the indexed codebase.\n" +
          "Examples\n" +
          "  - \"List all `async function` declarations\"\n" +
          "Returns\n" +
          "  { nodes: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  you want callers/dependents/impact — those are different tools.\n" +
          "Use repository_query instead — the harness delegates this query when needed.",
        contract: { visibility: "internal" },
        input: Schema.Struct({
          file: optionalString,
          language: optionalString,
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [
          { type: "text", text: formatNodes(output.nodes, "Async functions") },
        ],
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
        description:
          "Use when:\n" +
          "  structural queries — find HTTP route registrations (Express/Fastify style).\n" +
          "Examples\n" +
          "  - \"List all HTTP routes\"\n" +
          "  - \"Find POST /api routes in `src/server/`\"\n" +
          "Returns\n" +
          "  { nodes: CodegraphNode[] }\n" +
          "Avoid when\n" +
          "  you want callers/dependents/impact — those are different tools.\n" +
          "Use repository_query instead — the harness delegates this query when needed.",
        contract: { visibility: "internal" },
        input: Schema.Struct({
          file: optionalString,
          language: optionalString,
        }),
        output: OutputNodes,
        toModelOutput: ({ output }) => [
          { type: "text", text: formatNodes(output.nodes, "HTTP routes") },
        ],
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
