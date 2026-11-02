/**
 * `codegraph_build` / `codegraph_query` / `codegraph_impact` /
 * `codegraph_dependents` / `codegraph_callers` / `codegraph_remove`.
 *
 * Ported from v1 `packages/core/src/tool/codegraph.ts`. Tool IDs, parameter
 * names/descriptions and rendered text are unchanged; the v1 `Tool.make`
 * contract (`contract.visibility`, `toModelOutput`, `permission.assert`) maps
 * onto v2's `Tool.Info` (`options.permission`, `content` as model output).
 */
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { Interface as CodegraphAnalyzerInterface } from "../codegraph-analyzer.js"
import type { Interface as CodegraphBuildServiceInterface } from "../codegraph-build-service.js"
import type { Interface as CodegraphRepoInterface } from "../codegraph-repo.js"
import { GraphMeta, type CodegraphNode } from "../types.js"
import { resolveProjectRoot } from "../workspace-identity.js"
import { formatNodes } from "./format.js"
import { optionalBoolean, optionalNumber, optionalString } from "./schema.js"

export const name_build = "codegraph_build"
export const name_remove = "codegraph_remove"
export const name_query = "codegraph_query"
export const name_impact = "codegraph_impact"
export const name_dependents = "codegraph_dependents"
export const name_callers = "codegraph_callers"

export interface Deps {
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
  readonly buildService: CodegraphBuildServiceInterface
  /** The open project's root; every tool default resolves here, never the host cwd. */
  readonly projectRoot: () => string
  /** `banyancode_codegraph_exclude_patterns`, applied to an explicit build. */
  readonly excludePatterns?: () => Effect.Effect<readonly string[], never, never>
}

export const InputBuild = Schema.Struct({
  root: optionalString.annotate({
    description:
      "Workspace root to scan. Defaults to the open project's root " +
      "when omitted. A path outside the open project is refused.",
  }),
  force: optionalBoolean.annotate({
    description:
      "When true, wipes any existing index for the workspace before " +
      "rebuilding. Defaults to false (incremental). Set true after major " +
      "source re-organizations or when the graph is suspected corrupt.",
  }),
}).annotate({
  description:
    "Build (or rebuild) the code graph for the current workspace. " +
    "Walks the file tree, parses with tree-sitter, and indexes symbols + " +
    "edges into banyancode.db.",
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
  file: optionalString.annotate({
    description: "Optional filename or path substring filter (e.g. 'memory-repo').",
  }),
  function: optionalString.annotate({
    description:
      "Optional symbol name filter (e.g. 'update'). Returns nodes whose " + "name contains this substring.",
  }),
  kind: optionalString.annotate({
    description:
      "Optional node-kind filter (e.g. 'function', 'class', 'method'). " + "Exact match against CodegraphNode.kind.",
  }),
  limit: optionalNumber.annotate({
    description: "Maximum number of nodes to return. Defaults to 200 when omitted.",
  }),
}).annotate({
  description:
    "Raw codegraph query: list nodes matching the given filters. " +
    "All filters are optional but at least one should be provided — " +
    "an unfiltered query returns up to `limit` arbitrary nodes.",
})

export const OutputQuery = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      fileID: Schema.String,
      kind: Schema.String,
      name: Schema.String,
      signature: Schema.optional(Schema.String),
      startLine: Schema.Number,
      endLine: Schema.Number,
      code: Schema.optional(Schema.String),
    }),
  ),
  meta: Schema.optional(GraphMeta),
})

export const InputImpact = Schema.Struct({
  nodeID: optionalString.annotate({
    description:
      "The graph UUID of the starting node. Provide nodeID OR function — " + "the tool will reject calls with neither.",
  }),
  function: optionalString.annotate({
    description: "The symbol name to look up when nodeID is omitted " + "(e.g. 'MemoryRepo.update').",
  }),
  maxDepth: optionalNumber.annotate({
    description: "Maximum traversal depth for transitive dependents. Defaults to 8 " + "when omitted.",
  }),
  limit: optionalNumber.annotate({
    description: "Maximum number of result nodes to return. Defaults to 500.",
  }),
}).annotate({
  description:
    "Blast radius from a node: direct dependents and transitive dependents " + "in the code graph.",
})

export const OutputImpact = Schema.Struct({
  dependents: Schema.Array(Schema.Unknown),
  transitive: Schema.Array(Schema.Unknown),
  meta: Schema.optional(GraphMeta),
})

export const InputDependents = Schema.Struct({
  nodeID: optionalString.annotate({
    description: "The graph UUID of the target node. Provide nodeID OR function.",
  }),
  function: optionalString.annotate({
    description: "The symbol name to look up when nodeID is omitted.",
  }),
  limit: optionalNumber.annotate({
    description: "Maximum number of dependents to return. Defaults to 500.",
  }),
}).annotate({
  description: "Direct dependents of a node — symbols that import or reference it.",
})

export const OutputDependents = Schema.Struct({
  dependents: Schema.Array(Schema.Unknown),
  meta: Schema.optional(GraphMeta),
})

export const InputCallers = Schema.Struct({
  nodeID: optionalString.annotate({
    description: "The graph UUID of the target node. Provide nodeID OR function.",
  }),
  function: optionalString.annotate({
    description: "The symbol name to look up when nodeID is omitted.",
  }),
  limit: optionalNumber.annotate({
    description: "Maximum number of callers to return. Defaults to 500.",
  }),
}).annotate({
  description: "Direct callers of a node — places that invoke the given symbol.",
})

export const OutputCallers = Schema.Struct({
  callers: Schema.Array(Schema.Unknown),
  meta: Schema.optional(GraphMeta),
})

export const InputRemove = Schema.Struct({
  dropFile: optionalBoolean.annotate({
    description:
      "When true, clears every table, VACUUMs and truncates the WAL — the " +
      "strongest reset available while the plugin holds the database open. " +
      "The banyancode.db file itself is kept (SQLite must not unlink an open " +
      "database); a build right after writes into the emptied file.",
  }),
}).annotate({
  description:
    "Remove the current codegraph index. Frees disk space but does not " +
    "delete the banyancode.db file (the file is shared with sessions and memory).",
})

export const OutputRemove = Schema.Struct({
  status: Schema.Literals(["removed", "empty"]),
  sizeBefore: Schema.Number,
  sizeAfter: Schema.Number,
  freedBytes: Schema.Number,
  // Always false: the open database is cleared, never unlinked.
  droppedFile: Schema.Boolean,
})

const metaOrUndefined = (meta: {
  graphBuiltAt: number
  graphVersion: number
  graphCoverage: number
  totalFiles: number
  totalNodes: number
  totalEdges: number
} | undefined) =>
  meta
    ? {
        graphBuiltAt: meta.graphBuiltAt,
        graphVersion: meta.graphVersion,
        graphCoverage: meta.graphCoverage,
        totalFiles: meta.totalFiles,
        totalNodes: meta.totalNodes,
        totalEdges: meta.totalEdges,
      }
    : undefined

export const buildTool = (deps: Deps): Tool.Info<typeof InputBuild, typeof OutputBuild> => ({
  name: name_build,
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
  input: InputBuild,
  output: OutputBuild,
  options: { permission: name_build, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const resolution = resolveProjectRoot(deps.projectRoot(), input.root)
      if (resolution._tag === "Refused") {
        return yield* Effect.fail(new Tool.Error({ message: `codegraph_build: ${resolution.message}` }))
      }
      const root = resolution.root
      const configured = deps.excludePatterns ? yield* deps.excludePatterns() : []
      yield* deps.buildService.start({
        root,
        force: input.force ?? false,
        ...(configured.length > 0 ? { excludePatterns: configured } : {}),
      })

      let currentStatus = yield* deps.buildService.status()
      while (currentStatus.status === "running") {
        yield* Effect.sleep("500 millis")
        currentStatus = yield* deps.buildService.status()
      }

      if (currentStatus.status === "failed") {
        return yield* Effect.fail(
          new Tool.Error({ message: `codegraph_build failed: ${currentStatus.error ?? "unknown error"}` }),
        )
      }
      if (currentStatus.status === "cancelled") {
        return yield* Effect.fail(new Tool.Error({ message: "codegraph_build was cancelled" }))
      }

      const empty = {
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
        parseErrors: [] as Array<{ path: string; cause: string; indexedAt: number }>,
        meta: undefined,
      }

      if (currentStatus.status !== "completed" || !currentStatus.result) {
        return { output: empty, content: renderBuild(empty) }
      }

      const meta = yield* deps.repo.getMeta()
      const r = currentStatus.result
      const output = {
        indexed: r.indexed,
        skipped: r.skipped,
        duration_ms: r.duration_ms,
        symbolsIndexed: r.symbolsIndexed,
        skippedByReason: r.skippedByReason,
        parseErrors: currentStatus.parseErrors ?? [],
        meta: metaOrUndefined(meta),
      }
      return { output, content: renderBuild(output) }
    }),
})

const renderBuild = (output: typeof OutputBuild.Type): string => {
  const r = output.skippedByReason ?? {
    gitignored: 0,
    banyanignored: 0,
    artifact: 0,
    tooLarge: 0,
    minified: 0,
    tooLargeParse: 0,
    cached: 0,
    readError: 0,
    parseFailure: 0,
  }
  const lines = [
    `indexed=${output.indexed} skipped=${output.skipped}`,
    `skippedByReason.gitignored=${r.gitignored} banyanignored=${r.banyanignored} artifact=${r.artifact}`,
    `skippedByReason.tooLarge=${r.tooLarge} minified=${r.minified} tooLargeParse=${r.tooLargeParse}`,
    `skippedByReason.cached=${r.cached} readError=${r.readError} parseFailure=${r.parseFailure}`,
    `parseErrors.length=${output.parseErrors?.length ?? 0}`,
    `symbolsIndexed=${output.symbolsIndexed} duration_ms=${output.duration_ms}`,
  ]
  if (output.meta) {
    const m = output.meta
    lines.push(
      `meta.graphVersion=${m.graphVersion} meta.graphCoverage=${m.graphCoverage?.toFixed(4) ?? "n/a"} meta.totalFiles=${m.totalFiles} meta.totalNodes=${m.totalNodes} meta.totalEdges=${m.totalEdges}`,
    )
  }
  return lines.join("\n")
}

export const queryTool = (deps: Deps): Tool.Info<typeof InputQuery, typeof OutputQuery> => ({
  name: name_query,
  description:
    "Use when:\n" +
    "  looking up symbol(s) by name, file, or kind in the code graph (graph-level\n" +
    "  lookup; not user-facing semantic search).\n" +
    "Examples\n" +
    '  - "Where is `ToolCatalog` defined?"\n' +
    '  - "List all `function` nodes in `src/`"\n' +
    '  - "Find all symbols named `parse`"\n' +
    "Returns\n" +
    "  { nodes: CodegraphNode[], meta: { graphBuiltAt, graphVersion, graphCoverage,\n" +
    "    totalNodes, totalEdges } }\n" +
    "Avoid when\n" +
    "  the user gave an exact file path — use read; or for semantic repository\n" +
    "  questions — prefer repository_query.\n" +
    "After this, often: codegraph_callers, codegraph_dependents, codegraph_impact,\n" +
    "  repository_trace, repository_impact — to traverse the graph.\n" +
    "Before this: codegraph_build (if not built), repository_query (if unsure).",
  input: InputQuery,
  output: OutputQuery,
  options: { permission: name_query, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 50
      let nodes: CodegraphNode[] = []
      if (input.function) {
        nodes = (yield* deps.repo.searchNodesLight({ name: input.function, limit })) as CodegraphNode[]
      } else if (input.kind) {
        // TypeScript interfaces are stored with the other named types.
        nodes = (yield* deps.repo.listNodesByKind(input.kind === "interface" ? "type" : input.kind)).slice(0, limit)
      } else if (input.file) {
        const file = yield* deps.repo.getFileByPath(input.file)
        if (file) nodes = yield* deps.repo.listNodesByFile(file.id)
      } else {
        nodes = (yield* deps.repo.searchNodesLight({ limit })) as CodegraphNode[]
      }
      const meta = yield* deps.repo.getMeta()
      const output = { nodes: nodes.slice(0, limit), meta: metaOrUndefined(meta) }
      return { output, content: formatNodes(output.nodes, "Query results") }
    }).pipe(Effect.mapError(() => new Tool.Error({ message: "codegraph_query failed" }))),
})

export const impactTool = (deps: Deps): Tool.Info<typeof InputImpact, typeof OutputImpact> => ({
  name: name_impact,
  description:
    "Use when:\n" +
    "  full blast-radius analysis — direct AND transitive dependents of a node.\n" +
    "Examples\n" +
    '  - "What breaks if I change `MemoryRepo`?"\n' +
    "Returns\n" +
    "  { dependents: CodegraphNode[], transitive: CodegraphNode[], meta: { ... } }\n" +
    "Avoid when\n" +
    "  you only need direct callers/dependents — codegraph_callers or\n" +
    "  codegraph_dependents is cheaper.\n" +
    "After this, often: repository_impact, edit_plan — to plan an edit.\n" +
    "Before this: codegraph_query (to find nodeID), codegraph_build (if not built).",
  input: InputImpact,
  output: OutputImpact,
  options: { permission: name_impact, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 100
      const result = yield* deps.analyzer.impact({
        ...(input.nodeID !== undefined ? { nodeID: input.nodeID } : {}),
        ...(input.function !== undefined ? { function: input.function } : {}),
      })
      const meta = yield* deps.repo.getMeta()
      const output = {
        dependents: result.dependents.slice(0, limit),
        transitive: result.transitive.slice(0, limit),
        meta: metaOrUndefined(meta),
      }
      return {
        output,
        content: `${formatNodes(output.dependents, "Direct dependents")}\n${formatNodes(output.transitive, "Transitive dependents")}`,
      }
    }).pipe(Effect.mapError(() => new Tool.Error({ message: "codegraph_impact failed" }))),
})

export const dependentsTool = (deps: Deps): Tool.Info<typeof InputDependents, typeof OutputDependents> => ({
  name: name_dependents,
  description:
    "Use when:\n" +
    "  finding direct dependents (who calls/imports a given node) — graph-level.\n" +
    "Examples\n" +
    '  - "What depends on `Repository`?"\n' +
    '  - "Who imports `SessionProcessor`?"\n' +
    "Returns\n" +
    "  { dependents: CodegraphNode[], meta: { ... } }\n" +
    "Avoid when\n" +
    "  you want transitive blast radius — use codegraph_impact.\n" +
    "After this, often: codegraph_impact — for transitive reach.\n" +
    "Before this: codegraph_query (to find nodeID).",
  input: InputDependents,
  output: OutputDependents,
  options: { permission: name_dependents, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 50
      const result = yield* deps.analyzer.dependents({
        ...(input.nodeID !== undefined ? { nodeID: input.nodeID } : {}),
        ...(input.function !== undefined ? { function: input.function } : {}),
      })
      const meta = yield* deps.repo.getMeta()
      const output = { dependents: result.slice(0, limit), meta: metaOrUndefined(meta) }
      return { output, content: formatNodes(output.dependents as CodegraphNode[], "Dependents") }
    }).pipe(Effect.mapError(() => new Tool.Error({ message: "codegraph_dependents failed" }))),
})

export const callersTool = (deps: Deps): Tool.Info<typeof InputCallers, typeof OutputCallers> => ({
  name: name_callers,
  description:
    "Use when:\n" +
    "  finding what calls a function (graph-level reverse lookup).\n" +
    "Examples\n" +
    '  - "Who calls `parse()`?"\n' +
    '  - "What invokes `execute()`?"\n' +
    "Returns\n" +
    "  { callers: CodegraphNode[], meta: { ... } }\n" +
    "Avoid when\n" +
    "  you want transitive dependents — use codegraph_impact.\n" +
    "After this, often: repository_impact, edit_plan — to plan around the callers.\n" +
    "Before this: codegraph_query (to find nodeID).",
  input: InputCallers,
  output: OutputCallers,
  options: { permission: name_callers, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? 50
      const result = yield* deps.analyzer.callers({
        ...(input.nodeID !== undefined ? { nodeID: input.nodeID } : {}),
        ...(input.function !== undefined ? { function: input.function } : {}),
      })
      const meta = yield* deps.repo.getMeta()
      const output = { callers: result.slice(0, limit), meta: metaOrUndefined(meta) }
      return { output, content: formatNodes(output.callers as CodegraphNode[], "Callers") }
    }).pipe(Effect.mapError(() => new Tool.Error({ message: "codegraph_callers failed" }))),
})

export const removeTool = (deps: Deps): Tool.Info<typeof InputRemove, typeof OutputRemove> => ({
  name: name_remove,
  description:
    "Remove the current codegraph index. Use to recover from a corrupt or stale graph. " +
    "Does not delete the banyancode.db file by default (it is shared with sessions and memory).",
  input: InputRemove,
  output: OutputRemove,
  options: { permission: name_remove, codemode: true },
  execute: (input) =>
    Effect.gen(function* () {
      const [filesBefore, nodesBefore, edgesBefore] = yield* Effect.all([
        deps.repo.countFiles(),
        deps.repo.countNodes(),
        deps.repo.countEdges(),
      ])
      const graphWasEmpty = filesBefore === 0 && nodesBefore === 0 && edgesBefore === 0
      const { sizeBefore, sizeAfter, droppedFile } = yield* deps.repo.clearAll({
        dropFile: input.dropFile ?? false,
      })
      const freedBytes = Math.max(0, sizeBefore - sizeAfter)
      const output = {
        status: (graphWasEmpty ? "empty" : "removed") as "empty" | "removed",
        sizeBefore,
        sizeAfter,
        freedBytes,
        droppedFile,
      }
      const cleared =
        input.dropFile && !droppedFile
          ? " The database file is kept (the plugin holds it open) and now contains an empty schema; a build writes into it again."
          : ""
      const content =
        output.status === "empty"
          ? "Codegraph index was already empty."
          : `Codegraph index removed. Freed ${output.freedBytes} bytes (${output.sizeBefore} -> ${output.sizeAfter}).${cleared}`
      return { output, content }
    }).pipe(Effect.mapError(() => new Tool.Error({ message: "codegraph_remove failed" }))),
})

export const tools = (deps: Deps): ReadonlyArray<Tool.Info> => [
  buildTool(deps),
  queryTool(deps),
  impactTool(deps),
  dependentsTool(deps),
  callersTool(deps),
  removeTool(deps),
]
