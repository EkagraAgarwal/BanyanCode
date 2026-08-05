export * as CodeFindTool from "./code-find"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import type { Interface as CodegraphAnalyzerInterface } from "../banyancode/codegraph-analyzer"
import type { Interface as CodegraphReadinessInterface } from "../banyancode/codegraph-readiness"
import type { Interface as PermissionV2Interface } from "../permission"
import { Banyan, isStale } from "../banyancode"
import { countStaleFilesFor } from "../banyancode/graph-staleness"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema, GraphMeta } from "../banyancode/types"
import type { CodegraphFile, CodegraphNode } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { resolveGraphTargetPure, resolveGraphTargetStrict } from "../banyancode/symbol-resolver"
import type { ResolutionDerivation } from "../banyancode/symbol-resolver"
import { formatNodes } from "./codegraph-format"
import { optionalNumber } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

export const name = "code_find"

export const Input = Schema.Struct({
  intent: Schema.Literals([
    "definition",
    "callers",
    "dependents",
    "impact",
    "find_file",
  ]).annotate({
    description:
      "The kind of search to perform on the code graph. " +
      "Pick exactly one based on what the user is asking: " +
      "'definition' to locate where a symbol is declared; " +
      "'callers' to find every place that invokes the symbol; " +
      "'dependents' to find symbols that depend on the target; " +
      "'impact' to compute direct + transitive blast radius; " +
      "'find_file' to locate a file by name. " +
      "Every intent requires a non-empty `target`.",
  }),
  target: Schema.String.annotate({
    description:
      "REQUIRED for every intent. The symbol name (e.g. 'MemoryRepo.update'), " +
      "filename (e.g. 'memory-repo.ts'), or node ID (UUID:line-line). " +
      "Never pass an empty string or omit this field — if no target is clear from " +
      "the user's prompt, ask the user for one or call code_find with a different tool.",
  }),
  includeKeywordFallback: Schema.Boolean.annotate({
    description:
      "When true (recommended), if the exact symbol name isn't found the resolver " +
      "falls back to Context.Service tag, code-substring, and name-like matching. " +
      "Pass false only when the user explicitly asks for strict exact-name matching. " +
      "When false and no exact match exists, the tool returns _diagnostic='target-not-resolved'.",
  }),
  limit: optionalNumber.annotate({
    description:
      "Maximum number of results to return. Defaults to 50 when omitted. " +
      "Pass a smaller value (e.g. 10) when the user wants a short list, or larger " +
      "(e.g. 200) for broad exploration. Allowed range: 1-500.",
  }),
}).annotate({
  description:
    "Top-level symbol locator across the codebase graph. Routes to the right " +
    "downstream tool based on `intent`. Always pass both `intent` and `target`.",
})

export const DerivationSchema = Schema.Literals(["tag-fallback", "name-exact", "qualified-split", "code-substring", "name-like", "fts-bm25"])

const MatchEntrySchema = Schema.Struct({
  node: CodegraphNodeSchema,
  derivation: DerivationSchema,
})

export const Output = Schema.Struct({
  matches: Schema.Array(MatchEntrySchema),
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
  meta: Schema.optional(GraphMeta),
  intent: Schema.String,
  dispatchedTo: Schema.optional(Schema.String),
  // Phase 1 (freshness): how many of the matched files have an mtime newer
  // than their indexed_at — data for those files may be stale. Absent when 0.
  staleFiles: Schema.optional(Schema.Number),
  // `target-not-resolved` = resolver tried all strategies and missed.
  // `no-edges-found`    = target resolved, analyzer returned 0 results.
  // `empty-target`      = caller passed an empty `target`.
  _diagnostic: Schema.optional(
    Schema.Literals(["symbol-not-in-graph", "target-not-resolved", "no-edges-found", "empty-target", "stale-graph"]),
  ),
  // Surfaced when resolution succeeded — lets callers correlate the result
  // back to a derivation so the model can re-query differently if needed.
  resolvedNodeID: Schema.optional(Schema.String),
  resolvedDerivation: Schema.optional(DerivationSchema),
})

export const makeCodeFindTool = (deps: {
  readonly permission: PermissionV2Interface
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
  readonly readiness: CodegraphReadinessInterface
}) => {
  // Closure-captured file index — `execute` populates it lazily (only in
  // the impact-filepath and find_file branches, via `repo.listAllFiles()`)
  // and `toModelOutput` reads it. Single-fiber sequencing guarantees the
  // setter runs before the reader (Effect's settlement pipeline runs
  // execute → encode → toModelOutput sequentially within a fiber). Avoids
  // lifting toModelOutput to Effect just to thread one map through.
  const fileIndex: { byID?: ReadonlyMap<string, CodegraphFile> } = {}

  // Phase: auto-trigger a full or incremental codegraph build whenever the
  // code-find tool runs against an unbuilt or stale graph, so the agent
  // does not waste a turn on empty/incorrect data.
  const ensureGraphReady = Effect.gen(function* () {
    const ready = yield* deps.readiness.ensureReady({ root: path.resolve(process.cwd()) })
    if (ready.reason === "failed") {
      yield* Effect.logWarning(`code_find: readiness failed: ${ready.error ?? "unknown"}`)
    }
    return ready
  })

  return Tool.make({
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
      "  is enabled when the symbol is not found by name. Set to false to opt out.\n" +
      "  Strict mode returns _diagnostic='target-not-resolved' on miss instead of\n" +
      "  falling back to fuzzy matches.",
    contract: { visibility: "public" },
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => {
      // Only flag derivations that are actually fuzzy matches. tag-fallback
      // is the resolver's step 1 (Context.Service tag lookup) — the
      // highest-precision strategy, not a fallback.
      const fuzzyDerivation = output.resolvedDerivation
        && ["code-substring", "name-like", "fts-bm25"].includes(output.resolvedDerivation)
        ? output.resolvedDerivation
        : undefined
      const headerParts = [
        fuzzyDerivation ? `FALLBACK MATCH (derivation=${fuzzyDerivation}) -- verify before treating as the exact symbol` : null,
        `intent=${output.intent}`,
        `dispatched=${output.dispatchedTo ?? "n/a"}`,
        `matches=${output.matches.length}`,
        `files=${output.files.length}`,
      ]
      if (output.resolvedNodeID) headerParts.push(`resolved=${output.resolvedNodeID}`)
      if (output.resolvedDerivation) headerParts.push(`derivation=${output.resolvedDerivation}`)
      if (output._diagnostic) headerParts.push(`diagnostic=${output._diagnostic}`)
      const header = headerParts.filter((p): p is string => p !== null).join(" ")
      const nodeList = output.matches.map((m) => m.node)
      const matchesBlock = output.matches.length > 0
        ? formatNodes(nodeList, "Matches", fileIndex.byID)
        : "Matches: none."
      // Hide the Files block for non-find_file intents with no files —
      // those intents don't try to populate files; printing "Files: none."
      // makes a successful result look partial.
      const showFiles = output.intent === "find_file" || output.files.length > 0
      const filesBlock = !showFiles
        ? ""
        : output.files.length > 0
          ? `Files (${output.files.length}):\n${output.files.map((f) => `  ${f.path}`).join("\n")}`
          : "Files: none."
      return [{
        type: "text",
        text: filesBlock ? `${header}\n\n${matchesBlock}\n\n${filesBlock}` : `${header}\n\n${matchesBlock}`,
      }]
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
          yield* deps.permission.assert({
            action: name,
            resources: [input.target],
            save: ["*"],
            metadata: input,
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })

          yield* ensureGraphReady

          // `fileIndex` is populated lazily (inside the branches that
          // actually need file rows: impact-filepath and find_file) so
          // toModelOutput can render real file paths instead of fileID
          // UUIDs. Other intents skip the listAllFiles load entirely.

          const metaRow = yield* deps.repo.getMeta()
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
          const stale = isStale(meta)

          const resolveTarget = (
            target: string,
          ): Effect.Effect<
            | {
                nodeID: string
                node: CodegraphNode
                candidates: readonly CodegraphNode[]
                derivation: ResolutionDerivation
              }
            | { _tag: "Miss" }
          > =>
            Effect.gen(function* () {
              const result = input.includeKeywordFallback === false
                ? yield* resolveGraphTargetStrict(deps.repo, {
                    target,
                    limit,
                    allowKeywordFallback: false,
                  })
                : yield* resolveGraphTargetPure(deps.repo, { target, limit })
              return result._tag === "Ok" ? result.value : { _tag: "Miss" as const }
            })

          switch (input.intent) {
            case "definition": {
              const target = input.target ?? ""
              if (!target)
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_query",
                  _diagnostic: "empty-target" as const,
                }
              const resolved = yield* resolveTarget(target)
              if ("_tag" in resolved) {
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_query",
                  _diagnostic: "target-not-resolved" as const,
                }
              }
              const matches = resolved.candidates.map((n) => ({ node: n, derivation: resolved.derivation }))
              const matched = matches.slice(0, limit)
              const perFile = yield* countStaleFilesFor(deps.repo, matched.map((m) => m.node.fileID))
              const staleGraph = stale.stale || perFile.stale ? ("stale-graph" as const) : undefined
              return {
                matches: matched,
                files: [],
                meta,
                intent: input.intent,
                dispatchedTo: "codegraph_query",
                resolvedNodeID: resolved.nodeID,
                resolvedDerivation: resolved.derivation,
                ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
                ...(staleGraph ? { _diagnostic: staleGraph } : {}),
              }
            }
            case "callers": {
              if (!input.target)
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_callers",
                  _diagnostic: "empty-target" as const,
                }
              const resolved = yield* resolveTarget(input.target)
              if ("_tag" in resolved) {
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_callers",
                  _diagnostic: "target-not-resolved" as const,
                }
              }
              const result = yield* deps.analyzer.callers({ nodeID: resolved.nodeID }).pipe(
                Effect.matchEffect({
                  onFailure: (err) =>
                    err._tag === "Banyan/SymbolNotFoundError"
                      ? Effect.succeed<CodegraphNode[]>([])
                      : Effect.fail(err),
                  onSuccess: (nodes) => Effect.succeed(nodes),
                }),
              )
              const matches = result.map((n) => ({ node: n, derivation: resolved.derivation }))
              const isEmpty = matches.length === 0
              const perFile = yield* countStaleFilesFor(deps.repo, matches.map((m) => m.node.fileID))
              const _diagnostic = isEmpty
                ? ("no-edges-found" as const)
                : stale.stale || perFile.stale
                  ? ("stale-graph" as const)
                  : undefined
              return {
                matches,
                files: [],
                meta,
                intent: input.intent,
                dispatchedTo: "codegraph_callers",
                resolvedNodeID: resolved.nodeID,
                resolvedDerivation: resolved.derivation,
                ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
                ...(_diagnostic ? { _diagnostic } : {}),
              }
            }
            case "dependents": {
              if (!input.target)
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_dependents",
                  _diagnostic: "empty-target" as const,
                }
              const resolved = yield* resolveTarget(input.target)
              if ("_tag" in resolved) {
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_dependents",
                  _diagnostic: "target-not-resolved" as const,
                }
              }
              const result = yield* deps.analyzer.dependents({ nodeID: resolved.nodeID }).pipe(
                Effect.matchEffect({
                  onFailure: (err) =>
                    err._tag === "Banyan/SymbolNotFoundError"
                      ? Effect.succeed<CodegraphNode[]>([])
                      : Effect.fail(err),
                  onSuccess: (nodes) => Effect.succeed(nodes),
                }),
              )
              const matches = result.map((n) => ({ node: n, derivation: resolved.derivation }))
              const isEmpty = matches.length === 0
              const perFile = yield* countStaleFilesFor(deps.repo, matches.map((m) => m.node.fileID))
              const _diagnostic = isEmpty
                ? ("no-edges-found" as const)
                : stale.stale || perFile.stale
                  ? ("stale-graph" as const)
                  : undefined
              return {
                matches,
                files: [],
                meta,
                intent: input.intent,
                dispatchedTo: "codegraph_dependents",
                resolvedNodeID: resolved.nodeID,
                resolvedDerivation: resolved.derivation,
                ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
                ...(_diagnostic ? { _diagnostic } : {}),
              }
            }
            case "impact": {
              if (!input.target)
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_impact",
                  _diagnostic: "empty-target" as const,
                }
              // File-level impact: when the target looks like a filename or
              // contains a path separator, aggregate impact across every
              // symbol in that file. Previously the resolver tried to find
              // a single symbol whose name equals the filename, missed, and
              // returned `no-edges-found` even when the file had plenty of
              // callers (caveat #2 from the v2 probes).
              const looksLikeFilePath =
                /\.[a-z0-9]+$/i.test(input.target) || /[\\/]/.test(input.target)
              if (looksLikeFilePath) {
                const allFiles = yield* deps.repo.listAllFiles()
                fileIndex.byID = new Map(allFiles.map((f) => [f.id, f]))
                const sep = /[\\/]/.test(input.target) ? `[\\${"/"}]` : ""
                const fileHits = allFiles.filter((f) => f.path.endsWith(`${sep}${input.target}`))
                const fileIDs = new Set(fileHits.map((f) => f.id))
                // One bounded per-file query instead of a full-table
                // listAllNodes() — a file-level impact only needs the
                // symbols inside the matched file(s).
                const symbolNodes: CodegraphNode[] = []
                for (const fileID of fileIDs) {
                  const fileNodes = yield* deps.repo.listNodesByFile(fileID)
                  symbolNodes.push(...fileNodes.filter((n) => n.kind !== "file"))
                }
                if (symbolNodes.length === 0) {
                  return {
                    matches: [],
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_impact",
                    _diagnostic: "target-not-resolved" as const,
                  }
                }
                // Hoisted aggregation: one batched upstream BFS over
                // edgesToBatch/nodesByIDs replaces the N+1 loop of
                // per-symbol analyzer.impact() calls. It replicates
                // analyzer.impact's dependents + walkTransitive union
                // (direct dependents first, then transitive levels).
                const aggregated = yield* Effect.gen(function* () {
                  const seen = new Set<string>()
                  const dependents: CodegraphNode[] = []
                  const transitive: CodegraphNode[] = []
                  const visited = new Set<string>()
                  const maxDepth = 8
                  let frontier = symbolNodes.map((n) => n.id)
                  for (let depth = 0; frontier.length > 0 && depth <= maxDepth; depth++) {
                    const edges = yield* deps.repo.edgesToBatch(frontier)
                    const nextIDs: string[] = []
                    for (const edge of edges) {
                      const nextID = edge.fromNodeID
                      if (!visited.has(nextID)) {
                        visited.add(nextID)
                        nextIDs.push(nextID)
                      }
                    }
                    if (nextIDs.length > 0) {
                      const nodes = yield* deps.repo.nodesByIDs([...new Set(nextIDs)])
                      for (const n of nodes) {
                        if (seen.has(n.id)) continue
                        seen.add(n.id)
                        const bucket: CodegraphNode[] =
                          dependents.length < limit ? dependents : transitive
                        bucket.push(n)
                      }
                    }
                    frontier = nextIDs
                  }
                  return { dependents, transitive }
                })
                const matches: { node: CodegraphNode; derivation: ResolutionDerivation }[] = [
                  ...aggregated.dependents.map((n) => ({ node: n, derivation: "name-exact" as const })),
                  ...aggregated.transitive.map((n) => ({ node: n, derivation: "name-exact" as const })),
                ].slice(0, limit)
                const isEmpty = matches.length === 0
                const perFile = yield* countStaleFilesFor(deps.repo, matches.map((m) => m.node.fileID))
                const _diagnostic = isEmpty
                  ? ("no-edges-found" as const)
                  : stale.stale || perFile.stale
                    ? ("stale-graph" as const)
                    : undefined
                return {
                  matches,
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_impact",
                  resolvedDerivation: "name-exact" as const,
                  ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
                  ...(_diagnostic ? { _diagnostic } : {}),
                }
              }
              const resolved = yield* resolveTarget(input.target)
              if ("_tag" in resolved) {
                return {
                  matches: [],
                  files: [],
                  meta,
                  intent: input.intent,
                  dispatchedTo: "codegraph_impact",
                  _diagnostic: "target-not-resolved" as const,
                }
              }
              const result = yield* deps.analyzer.impact({ nodeID: resolved.nodeID }).pipe(
                Effect.matchEffect({
                  onFailure: (err) =>
                    err._tag === "Banyan/SymbolNotFoundError"
                      ? Effect.succeed<{ dependents: CodegraphNode[]; transitive: CodegraphNode[] }>({
                          dependents: [],
                          transitive: [],
                        })
                      : Effect.fail(err),
                  onSuccess: (impact) => Effect.succeed(impact),
                }),
              )
              const matches: { node: CodegraphNode; derivation: ResolutionDerivation }[] = [
                ...result.dependents.map((n) => ({ node: n, derivation: resolved.derivation })),
                ...result.transitive.map((n) => ({ node: n, derivation: resolved.derivation })),
              ].slice(0, limit)
              const isEmpty = matches.length === 0
              const perFile = yield* countStaleFilesFor(deps.repo, matches.map((m) => m.node.fileID))
              const _diagnostic = isEmpty
                ? ("no-edges-found" as const)
                : stale.stale || perFile.stale
                  ? ("stale-graph" as const)
                  : undefined
              return {
                matches,
                files: [],
                meta,
                intent: input.intent,
                dispatchedTo: "codegraph_impact",
                resolvedNodeID: resolved.nodeID,
                resolvedDerivation: resolved.derivation,
                ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
                ...(_diagnostic ? { _diagnostic } : {}),
              }
            }
            case "find_file": {
              const target = input.target ?? ""
              if (!target) return { matches: [], files: [], meta, intent: input.intent, dispatchedTo: "codegraph_query", _diagnostic: "empty-target" as const }
              // File rows are only needed here — load them lazily so
              // other intents never pay for the listAllFiles roundtrip.
              const allFiles = yield* deps.repo.listAllFiles()
              fileIndex.byID = new Map(allFiles.map((f) => [f.id, f]))

              const looksLikeFilename = /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|sql|py|pyw|go|rs|java|kt|c|cpp|cc|cxx|h|hpp|hh|css|html|sh|ps1|vue|svelte|mdx)$/i.test(target)
              const sep = /[\\/]/.test(target) ? `[\\${"/"}]` : ""

              let files: { path: string }[]
              let matches: { node: CodegraphNode; derivation: ResolutionDerivation }[]
              let dispatchedTo: string
              let matchedFileIDs: ReadonlyArray<string> = []

              if (looksLikeFilename || sep !== "") {
                const pathFiltered = allFiles.filter((f) => f.path.endsWith(`${sep}${target}`)).slice(0, limit)
                files = pathFiltered.map((f) => ({ path: f.path }))
                const fileIDs = new Set(pathFiltered.map((f) => f.id))
                matchedFileIDs = [...fileIDs]
                // Bounded per-fileID pushdown (no heavy `code` column)
                // plus file-kind nodes named exactly `target`.
                const symbolMatches: CodegraphNode[] = []
                for (const fileID of fileIDs) {
                  const fileNodes = yield* deps.repo.searchNodesLight({ fileID, limit })
                  symbolMatches.push(...fileNodes)
                }
                const fileKindNodes = yield* deps.repo.searchNodesLight({ name: target, limit })
                symbolMatches.push(...fileKindNodes.filter((n) => n.kind === "file" && n.name === target))
                matches = symbolMatches.slice(0, limit).map((n) => ({ node: n, derivation: "name-exact" as const }))
                dispatchedTo = files.length > 0 ? "graph" : "glob"
              } else {
                const symbolMatches = (yield* deps.repo.searchNodesLight({ name: target, limit }))
                  .filter((n) => n.kind !== "file" && n.name === target)
                const fileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
                matchedFileIDs = fileIDs
                files = allFiles
                  .filter((f) => fileIDs.includes(f.id))
                  .slice(0, limit)
                  .map((f) => ({ path: f.path }))
                matches = symbolMatches
                  .slice(0, limit)
                  .map((n) => ({ node: n, derivation: "name-exact" as const }))
                dispatchedTo = files.length > 0 ? "graph" : "glob"
                if (files.length === 0) {
                  files = allFiles
                    .filter((f) => f.path.includes(target))
                    .slice(0, limit)
                    .map((f) => ({ path: f.path }))
                  dispatchedTo = "glob"
                }
              }

              const perFile = yield* countStaleFilesFor(deps.repo, matchedFileIDs)
              const staleGraph = stale.stale || perFile.stale ? ("stale-graph" as const) : undefined
              return {
                matches,
                files,
                meta,
                intent: input.intent,
                dispatchedTo,
                ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
                ...(staleGraph ? { _diagnostic: staleGraph } : {}),
              }
            }
          }
        }),
      ).pipe(Effect.mapError((err) => {
        if (err instanceof ToolFailure) return err
        return new ToolFailure({ message: `code_find failed for intent=${input.intent}` })
      }))
    },
  })
}

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer
    const readiness = yield* Banyan.CodegraphReadiness

    yield* tools.register({
      [name]: makeCodeFindTool({
        permission: permission as PermissionV2Interface,
        repo: repo as CodegraphRepoInterface,
        analyzer: analyzer as CodegraphAnalyzerInterface,
        readiness: readiness as CodegraphReadinessInterface,
      }),
    })
  }),
)
