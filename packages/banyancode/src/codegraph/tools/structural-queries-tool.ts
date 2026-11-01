/**
 * Structural query tools — `codegraph_find_implementations`,
 * `codegraph_find_overrides`, `codegraph_find_recursive`,
 * `codegraph_find_async`, `codegraph_find_http_routes`.
 *
 * Ported from v1 `packages/core/src/tool/structural-queries-tool.ts` with the
 * same IDs, parameter names/descriptions and rendered output.
 */
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { Interface as StructuralQueriesInterface } from "../structural-queries/structural-queries.js"
import { CodegraphNodeSchema } from "../types.js"
import { formatNodes } from "./format.js"
import { optionalString } from "./schema.js"

export const name_find_implementations = "codegraph_find_implementations"
export const name_find_overrides = "codegraph_find_overrides"
export const name_find_recursive = "codegraph_find_recursive"
export const name_find_async = "codegraph_find_async"
export const name_find_http_routes = "codegraph_find_http_routes"

const OutputNodes = Schema.Struct({
  nodes: Schema.Array(CodegraphNodeSchema),
})

export interface Deps {
  readonly structural: StructuralQueriesInterface
}

const make =
  (
    toolName: string,
    description: string,
    header: string,
    input: Schema.Schema<any>,
    run: (structural: StructuralQueriesInterface, value: any) => Effect.Effect<any[]>,
  ) =>
  (deps: Deps): Tool.Info =>
  ({
    name: toolName,
    description,
    input,
    output: OutputNodes,
    options: { permission: toolName, codemode: true },
    execute: ((value: any) =>
      Effect.gen(function* () {
        const nodes = yield* run(deps.structural, value)
        return { output: { nodes }, content: formatNodes(nodes, header) }
      }).pipe(Effect.mapError(() => new Tool.Error({ message: `${toolName} failed` }))) as never),
  }) as never

const fileField = optionalString.annotate({ description: "Optional filename substring filter." })
const languageField = optionalString.annotate({ description: "Optional language filter." })

const implementations = make(
  name_find_implementations,
  "Use when:\n" +
    "  structural queries — find classes that implement or extend an interface/base.\n" +
    "Examples\n" +
    '  - "Find implementations of `Repository`"\n' +
    '  - "Classes that extend `BaseService`"\n' +
    "Returns\n" +
    "  { nodes: CodegraphNode[] }\n" +
    "Avoid when\n" +
    "  you want callers/dependents/impact — those are different tools.\n" +
    "After this, often: repository_explain — to read the most-used implementation.\n" +
    "Before this: codegraph_build (if not built).",
  "Implementations",
  Schema.Struct({
    interfaceName: Schema.String.annotate({
      description: "REQUIRED. The interface name to find implementations for " + "(e.g. 'RepositoryIntelligence').",
    }),
    file: fileField,
    language: languageField,
  }),
  (structural, value) => structural.findImplementations(value),
)

const overrides = make(
  name_find_overrides,
  "Use when:\n" +
    "  structural queries — find method overrides by name across subclasses.\n" +
    "Examples\n" +
    '  - "Find all `parse()` overrides"\n' +
    "Returns\n" +
    "  { nodes: CodegraphNode[] }\n" +
    "Avoid when\n" +
    "  you want callers/dependents/impact — those are different tools.\n" +
    "After this, often: repository_explain — to compare override behavior.\n" +
    "Before this: codegraph_build (if not built).",
  "Overrides",
  Schema.Struct({
    methodName: Schema.String.annotate({
      description: "REQUIRED. The method name to find overrides for " + "(e.g. 'parse').",
    }),
    baseClass: optionalString.annotate({
      description:
        "Optional base class to scope overrides to " +
        "(e.g. 'Parser'). When omitted, returns all matching overrides.",
    }),
    file: fileField,
    language: languageField,
  }),
  (structural, value) => structural.findOverrides(value),
)

const recursive = make(
  name_find_recursive,
  "Use when:\n" +
    "  structural queries — find recursive functions in the indexed codebase.\n" +
    "Examples\n" +
    '  - "List all recursive functions"\n' +
    "Returns\n" +
    "  { nodes: CodegraphNode[] }\n" +
    "Avoid when\n" +
    "  you want callers/dependents/impact — those are different tools.\n" +
    "Use repository_query instead — the harness delegates this query when needed.",
  "Recursive functions",
  Schema.Struct({ file: fileField, language: languageField }),
  (structural, value) => structural.findRecursiveFunctions(value),
)

const asyncFunctions = make(
  name_find_async,
  "Use when:\n" +
    "  structural queries — find `async` functions in the indexed codebase.\n" +
    "Examples\n" +
    '  - "List all `async function` declarations"\n' +
    "Returns\n" +
    "  { nodes: CodegraphNode[] }\n" +
    "Avoid when\n" +
    "  you want callers/dependents/impact — those are different tools.\n" +
    "Use repository_query instead — the harness delegates this query when needed.",
  "Async functions",
  Schema.Struct({ file: fileField, language: languageField }),
  (structural, value) => structural.findAsyncFunctions(value),
)

const httpRoutes = make(
  name_find_http_routes,
  "Use when:\n" +
    "  structural queries — find HTTP route registrations (Express/Fastify style).\n" +
    "Examples\n" +
    '  - "List all HTTP routes"\n' +
    '  - "Find POST /api routes in `src/server/`"\n' +
    "Returns\n" +
    "  { nodes: CodegraphNode[] }\n" +
    "Avoid when\n" +
    "  you want callers/dependents/impact — those are different tools.\n" +
    "Use repository_query instead — the harness delegates this query when needed.",
  "HTTP routes",
  Schema.Struct({ file: fileField, language: languageField }),
  (structural, value) => structural.findHTTPRoutes(value),
)

export const tools = (deps: Deps): ReadonlyArray<Tool.Info> => [
  implementations(deps),
  overrides(deps),
  recursive(deps),
  asyncFunctions(deps),
  httpRoutes(deps),
]
