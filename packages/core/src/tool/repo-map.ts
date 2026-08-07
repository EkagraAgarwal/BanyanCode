export * as RepoMapTool from "./repo-map"

import { Effect, Layer, Schema } from "effect"
import path from "path"
import { Banyan, isStale } from "../banyancode"
import { traced } from "../observability/trace"
import { GraphMeta } from "../banyancode/types"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import { PermissionV2 } from "../permission"
import type { Interface as RepoMapInterface } from "../banyancode/repo-map-service"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { optionalNumber } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "banyan_repo_map"

const PathField = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 _./-]+$/))
const QueryField = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9 _./-]+$/))

export const Input = Schema.Struct({
  root: Schema.optional(PathField.annotate({
    description: "Optional absolute or `./`-relative root to scope the repo map. Defaults to the caller's cwd.",
  })),
  path: Schema.optional(PathField.annotate({
    description: "Optional file path to inspect in detail. Mutually exclusive with `query` — pass one or the other (or both with `path` taking priority).",
  })),
  query: Schema.optional(QueryField.annotate({
    description: "Optional free-text query routed through the codegraph FTS index. Mutually exclusive with `path` — pass one or the other (or both with `path` taking priority).",
  })),
  limit: optionalNumber.annotate({
    description: "Maximum number of packages, entry points, and search hits to return. Defaults to 50. Allowed range: 1-200.",
  }),
}).pipe(
  // C1: require at least one of root/path/query AT THE SCHEMA LEVEL so an
  // empty `{}` call fails validation before execute (previously it passed the
  // schema — all fields optional — and only errored in the handler, wasting a
  // full tool round-trip; the benchmark transcript shows the model's very
  // first graph-tool call dying on exactly this). Overview callers pass
  // `root` (e.g. "."). `Schema.check` does not change the JSON schema the
  // model sees — the fields stay optional, with the guidance in the
  // description below.
  Schema.check(
    Schema.makeFilter(
      (input) =>
        input.root !== undefined || input.path !== undefined || input.query !== undefined
          ? true
          : "banyan_repo_map: at least one of `root`, `path`, or `query` must be provided.",
    ),
  ),
).annotate({
  description:
    "Token-budgeted outline of the most structurally central symbols in the " +
    "current workspace. Use this before reading files: it returns packages, " +
    "entry points, and per-file symbols without leaving the registry. " +
    "Pass at least one of `root`, `path`, or `query`; if all three are omitted " +
    "the tool returns an `error` instead of guessing.",
})

const EntryPointSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  path: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
  signature: Schema.optional(Schema.String),
})

const PackageSchema = Schema.Struct({
  path: Schema.String,
  files: Schema.Int,
  nodes: Schema.Int,
})

const DetailSymbolSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
  signature: Schema.optional(Schema.String),
})

const DetailsSchema = Schema.Struct({
  path: Schema.String,
  found: Schema.Boolean,
  symbols: Schema.Array(DetailSymbolSchema),
})

const SearchHitSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  path: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
  signature: Schema.optional(Schema.String),
  relevance: Schema.Number,
})

export const Output = Schema.Struct({
  mode: Schema.Literals(["overview", "detail", "search"]),
  root: Schema.String,
  graphVersion: Schema.Int,
  totalNodes: Schema.Int,
  fileKindCounts: Schema.Record(Schema.String, Schema.Int),
  packages: Schema.Array(PackageSchema),
  entryPoints: Schema.Array(EntryPointSchema),
  details: Schema.optional(Schema.Struct({
    path: Schema.String,
    symbols: Schema.Array(DetailSymbolSchema),
  })),
  search: Schema.optional(Schema.Array(SearchHitSchema)),
  meta: Schema.optional(GraphMeta),
  _diagnostic: Schema.optional(Schema.Literals([
    "no-input", "no-graph", "stale-graph",
    "file-not-in-graph", "file-has-no-symbols", "no-matches",
  ])),
})

const renderOutput = (output: Schema.Schema.Type<typeof Output>): string => {
  const header = `mode=${output.mode} graphVersion=${output.graphVersion} totalNodes=${output.totalNodes}${output._diagnostic ? ` diagnostic=${output._diagnostic}` : ""}`
  const kindLines = Object.entries(output.fileKindCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([kind, count]) => `  ${kind}=${count}`)
    .join("\n")
  const packageLines = output.packages
    .slice(0, 10)
    .map((pkg) => `  ${pkg.path}  files=${pkg.files} nodes=${pkg.nodes}`)
    .join("\n")
  const entryLines = output.entryPoints
    .slice(0, 10)
    .map((entry) => `  ${entry.name} (${entry.kind}) @ ${entry.path}:${entry.startLine}`)
    .join("\n")
  const detailsBlock = output.details
    ? output.details.symbols.length === 0
      ? `Details (${output.details.path}): none.`
      : `Details (${output.details.path}, ${output.details.symbols.length}):\n${output.details.symbols
          .slice(0, 30)
          .map((symbol) => `  ${symbol.name} (${symbol.kind}) L${symbol.startLine}-${symbol.endLine}`)
          .join("\n")}`
    : ""
  const searchBlock = output.search && output.search.length > 0
    ? `Search (${output.search.length}):\n${output.search
        .slice(0, 20)
        .map((hit) => `  ${hit.name} (${hit.kind}) @ ${hit.path}:${hit.startLine} rel=${hit.relevance.toFixed(3)}`)
        .join("\n")}`
    : output.search && output.search.length === 0
      ? "Search: no matches."
      : ""
  // Distinguish "not indexed" from "indexed but symbol-less", and surface
  // the attempted canonical path plus a recovery hint instead of a bare
  // failure literal.
  const attemptedPath = output.details?.path ?? ""
  const diagnosticHint =
    output._diagnostic === "file-not-in-graph"
      ? `\n\nNot in graph: "${attemptedPath}" is not in the codegraph index. Run /codegraph-build (or /codegraph-build --force) to index it, or check the path spelling.`
      : output._diagnostic === "file-has-no-symbols"
        ? `\n\nNo symbols: "${attemptedPath}" is in the graph but has no indexed symbols — it may be a config/data/empty file.`
        : ""
  const blocks = [
    header,
    "File kinds:\n" + (kindLines || "  (none)"),
    "Packages:\n" + (packageLines || "  (none)"),
    "Entry points:\n" + (entryLines || "  (none)"),
    detailsBlock,
    searchBlock,
    diagnosticHint,
  ].filter((part) => part.length > 0)
  return blocks.join("\n\n")
}

export const makeRepoMapTool = (deps: {
  readonly permission: PermissionV2.Interface
  readonly repo: CodegraphRepoInterface
  readonly map: RepoMapInterface
}) =>
  Tool.make({
    description:
      "Use when:\n" +
      "  the model needs a token-budgeted outline of the workspace before " +
      "  reading files. Returns packages, entry points, and per-file symbols " +
      "  without ever leaving the registry.\n" +
      "Examples\n" +
      "  - \"What's the structure of the project?\"\n" +
      "  - \"Show me the entry points\"\n" +
      "  - \"What symbols are in `src/auth/service.ts`?\"\n" +
      "  - \"Search for `UserService` symbols\"\n" +
      "Returns\n" +
      "  { mode, packages, entryPoints, fileKindCounts, details?, search? }\n" +
      "Avoid when\n" +
      "  you already have a nodeID — use codegraph_query or repository_query.\n" +
      "After this, often: code_find (locate specific symbols), " +
      "  repository_query (semantic context).\n" +
      "Routing tier note: this tool is HOT for the agent (always available). " +
      "  Use banyan_tool_search to discover cold tools (advanced/internal) " +
      "  before reaching for the registry.",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: renderOutput(output) }],
    execute: (input, context) => {
      const root = input.root ? path.resolve(input.root) : process.cwd()
      return traced(
        root,
        context.sessionID,
        name,
        input,
        (output) => `mode=${output.mode} packages=${output.packages.length} entryPoints=${output.entryPoints.length}`,
        Effect.gen(function* () {
          if (!input.root && !input.path && !input.query) {
            return yield* Effect.fail(new Tool.Failure({
              message: "banyan_repo_map: at least one of `root`, `path`, or `query` must be provided.",
            }))
          }
          yield* deps.permission.assert({
            action: name,
            resources: [input.path ?? input.query ?? input.root ?? root],
            save: ["*"],
            metadata: { root, ...(input.path ? { path: input.path } : {}), ...(input.query ? { query: input.query } : {}) },
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          }).pipe(Effect.orDie)

          const meta = yield* deps.repo.getMeta()
          const stale = isStale(meta)
          // meta is passed through so the overview does not re-read the
          // meta row (it needs graphVersion; the tool already fetched it).
          const overview = yield* deps.map.overview({ root, limit: input.limit, meta })
          const base: Omit<Schema.Schema.Type<typeof Output>, "mode" | "details" | "search"> = {
            root,
            graphVersion: overview.graphVersion,
            totalNodes: overview.totalNodes,
            fileKindCounts: overview.fileKindCounts as Readonly<Record<string, number>>,
            packages: overview.packages,
            entryPoints: overview.entryPoints,
            ...(meta ? {
              meta: {
                graphBuiltAt: meta.graphBuiltAt,
                graphVersion: meta.graphVersion,
                graphCoverage: meta.graphCoverage,
                totalFiles: meta.totalFiles,
                totalNodes: meta.totalNodes,
                totalEdges: meta.totalEdges,
              },
            } : {}),
          }
          const staleDiagnostic = stale.stale ? ("stale-graph" as const) : undefined
          const noGraph = !meta || meta.totalFiles === 0 ? ("no-graph" as const) : undefined
          const diagnostic = staleDiagnostic ?? noGraph
          const withDiagnostic = <T extends object>(value: T): T & { _diagnostic?: typeof diagnostic } =>
            diagnostic ? { ...value, _diagnostic: diagnostic } : value

          if (input.path) {
            const detail = yield* deps.map.detail({ root, path: input.path })
            if (!detail.found) {
              return withDiagnostic({ ...base, mode: "detail" as const, details: detail, _diagnostic: "file-not-in-graph" as const })
            }
            if (detail.symbols.length === 0) {
              return withDiagnostic({ ...base, mode: "detail" as const, details: detail, _diagnostic: "file-has-no-symbols" as const })
            }
            return withDiagnostic({ ...base, mode: "detail" as const, details: detail })
          }
          if (input.query) {
            const hits = yield* deps.map.search({ root, query: input.query, limit: input.limit })
            if (hits.length === 0) {
              return withDiagnostic({ ...base, mode: "search" as const, search: hits, _diagnostic: "no-matches" as const })
            }
            return withDiagnostic({ ...base, mode: "search" as const, search: hits })
          }
          return withDiagnostic({ ...base, mode: "overview" as const })
        }),
      )
    },
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const map = yield* Banyan.RepoMapService

    yield* tools.register({
      [name]: makeRepoMapTool({
        permission,
        repo: repo as unknown as Parameters<typeof makeRepoMapTool>[0]["repo"],
        map,
      }),
    })
  }),
)
