/**
 * `code_find` — top-level symbol locator.
 *
 * Ported from v1 `packages/core/src/tool/code-find.ts`. Intent names,
 * parameters, diagnostics and rendered text are unchanged. The v1 lazy
 * `fileIndex` existed only to satisfy `toModelOutput`; v2 renders content
 * inside `execute`, so the map is a plain local.
 */
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import type { Interface as CodegraphAnalyzerInterface } from "../codegraph-analyzer.js"
import type { Interface as CodegraphRepoInterface } from "../codegraph-repo.js"
import type { Interface as CodegraphReadinessInterface } from "../codegraph-readiness.js"
import { ensureReadyBounded } from "../codegraph-readiness.js"
import { countStaleFilesFor, isStale } from "../graph-staleness.js"
import { resolveGraphTargetPure, resolveGraphTargetStrict } from "../symbol-resolver.js"
import type { ResolutionDerivation } from "../symbol-resolver.js"
import { CodegraphNodeSchema, GraphMeta, type CodegraphFile, type CodegraphNode } from "../types.js"
import { formatNodes } from "./format.js"
import { optionalNumber } from "./schema.js"

export const name = "code_find"

export interface Deps {
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
  readonly readiness: CodegraphReadinessInterface
  /** Workspace root the graph is queried for. */
  readonly projectRoot: () => string
}

export const Input = Schema.Struct({
  intent: Schema.Literals(["definition", "callers", "dependents", "impact", "find_file"]).annotate({
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

export const DerivationSchema = Schema.Literals([
  "tag-fallback",
  "name-exact",
  "qualified-split",
  "code-substring",
  "name-like",
  "fts-bm25",
])

const MatchEntrySchema = Schema.Struct({
  node: CodegraphNodeSchema,
  derivation: DerivationSchema,
  path: Schema.optional(Schema.String),
})

export const Output = Schema.Struct({
  matches: Schema.Array(MatchEntrySchema),
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
  meta: Schema.optional(GraphMeta),
  intent: Schema.String,
  dispatchedTo: Schema.optional(Schema.String),
  staleFiles: Schema.optional(Schema.Number),
  _diagnostic: Schema.optional(
    Schema.Literals(["symbol-not-in-graph", "target-not-resolved", "no-edges-found", "empty-target", "stale-graph"]),
  ),
  resolvedNodeID: Schema.optional(Schema.String),
  resolvedDerivation: Schema.optional(DerivationSchema),
})

type OutputType = typeof Output.Type
type MatchEntry = { node: CodegraphNode; derivation: ResolutionDerivation; path?: string }

const withMatchPaths = (repo: CodegraphRepoInterface, matches: ReadonlyArray<{ node: CodegraphNode; derivation: ResolutionDerivation; path?: string }>) =>
  Effect.gen(function* () {
    const ids = [...new Set(matches.map((m) => m.node.fileID))]
    const files = yield* Effect.forEach(ids, (id) => repo.getFile(id), { concurrency: 8 })
    const paths = new Map(ids.flatMap((id, i) => (files[i] ? [[id, files[i]!.path] as const] : [])))
    return matches.map((m) => {
      const path = paths.get(m.node.fileID)
      return path ? { ...m, path } : m
    })
  })

const render = (output: OutputType, fileIndex?: ReadonlyMap<string, CodegraphFile>): string => {
  // Match entries carry their resolved path; merge those in so the rendered
  // line is `path:start-end` even when the caller did not load the file index.
  const filesByID = new Map<string, CodegraphFile>(fileIndex ?? [])
  for (const match of output.matches) {
    if (match.path && !filesByID.has(match.node.fileID)) {
      filesByID.set(match.node.fileID, {
        id: match.node.fileID,
        path: match.path,
        contentHash: "",
        language: "",
        indexedAt: 0,
      })
    }
  }
  const fuzzyDerivation =
    output.resolvedDerivation && ["code-substring", "name-like", "fts-bm25"].includes(output.resolvedDerivation)
      ? output.resolvedDerivation
      : undefined
  const headerParts = [
    fuzzyDerivation
      ? `FALLBACK MATCH (derivation=${fuzzyDerivation}) -- verify before treating as the exact symbol`
      : null,
    `intent=${output.intent}`,
    `dispatched=${output.dispatchedTo ?? "n/a"}`,
    `matches=${output.matches.length}`,
    `files=${output.files.length}`,
  ]
  if (output.resolvedNodeID) headerParts.push(`resolved=${output.resolvedNodeID}`)
  if (output.resolvedDerivation) headerParts.push(`derivation=${output.resolvedDerivation}`)
  if (output._diagnostic) headerParts.push(`diagnostic=${output._diagnostic}`)
  const header = headerParts.filter((p): p is string => p !== null).join(" ")
  const nodeList = output.matches.map((m) => m.node) as CodegraphNode[]
  const matchesBlock = output.matches.length > 0 ? formatNodes(nodeList, "Matches", filesByID) : "Matches: none."
  const showFiles = output.intent === "find_file" || output.files.length > 0
  const filesBlock = !showFiles
    ? ""
    : output.files.length > 0
      ? `Files (${output.files.length}):\n${output.files.map((f) => `  ${f.path}`).join("\n")}`
      : "Files: none."
  return filesBlock ? `${header}\n\n${matchesBlock}\n\n${filesBlock}` : `${header}\n\n${matchesBlock}`
}

export const tool = (deps: Deps): Tool.Info<typeof Input, typeof Output> => ({
  name,
  description:
    "Use when:\n" +
    "  top-level symbol locator across the codebase — routes to the right tool\n" +
    "  based on the `intent` you pass.\n" +
    "Examples\n" +
    '  - "Find `ToolCatalog`"\n' +
    '  - "Where is `SessionTools.resolve`?"\n' +
    '  - "Open `ConfigLoader`"\n' +
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
  input: Input,
  output: Output,
  options: { permission: name, codemode: true },
  execute: (input) => {
    const limit = input.limit ?? 50
    return Effect.gen(function* () {
      const effective = yield* Effect.sync(() => deps.projectRoot())
      const ready = yield* ensureReadyBounded(deps.readiness, { root: effective })
      if (ready.reason === "failed") {
        yield* Effect.logWarning(`code_find: readiness failed: ${ready.error ?? "unknown"}`)
      }

      const fileIndex: { byID?: ReadonlyMap<string, CodegraphFile> } = {}

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
      ): Effect.Effect<{ nodeID: string; node: CodegraphNode; candidates: readonly CodegraphNode[]; derivation: ResolutionDerivation } | { _tag: "Miss" }> =>
        Effect.gen(function* () {
          const result =
            input.includeKeywordFallback === false
              ? yield* resolveGraphTargetStrict(deps.repo, { target, limit, allowKeywordFallback: false })
              : yield* resolveGraphTargetPure(deps.repo, { target, limit })
          return result._tag === "Ok" ? result.value : { _tag: "Miss" as const }
        })

      const build = (matches: MatchEntry[], extra: Omit<Partial<OutputType>, "matches">): OutputType => ({
        matches,
        files: [],
        ...(meta ? { meta } : {}),
        intent: input.intent,
        ...extra,
      })

      const emptyFor = (dispatchedTo: string, diagnostic: OutputType["_diagnostic"]) =>
        finish([], { files: [], dispatchedTo, ...(diagnostic ? { _diagnostic: diagnostic } : {}) })

      const finish = (matches: MatchEntry[], extra: Omit<Partial<OutputType>, "matches">) =>
        Effect.gen(function* () {
          const withPaths = yield* withMatchPaths(deps.repo, matches)
          const output = build(withPaths, extra)
          return { output, content: render(output, fileIndex.byID) }
        })

      switch (input.intent) {
        case "definition": {
          const target = input.target ?? ""
          if (!target) return yield* emptyFor("codegraph_query", "empty-target")
          const resolved = yield* resolveTarget(target)
          if ("_tag" in resolved) return yield* emptyFor("codegraph_query", "target-not-resolved")
          const matches = resolved.candidates.map((n) => ({ node: n, derivation: resolved.derivation }))
          const matched = matches.slice(0, limit)
          const perFile = yield* countStaleFilesFor(
            deps.repo,
            matched.map((m) => m.node.fileID),
          )
          const result = yield* finish(matched, {
            dispatchedTo: "codegraph_query",
            resolvedNodeID: resolved.nodeID,
            resolvedDerivation: resolved.derivation,
            ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
            ...(stale.stale || perFile.stale ? { _diagnostic: "stale-graph" as const } : {}),
          })
          return result
        }
        case "callers": {
          if (!input.target) return yield* emptyFor("codegraph_callers", "empty-target")
          const resolved = yield* resolveTarget(input.target)
          if ("_tag" in resolved) return yield* emptyFor("codegraph_callers", "target-not-resolved")
          const result = yield* deps.analyzer
            .callers({ nodeID: resolved.nodeID })
            .pipe(Effect.orElseSucceed(() => [] as CodegraphNode[]))
          const matches = result.map((n) => ({ node: n, derivation: resolved.derivation }))
          const perFile = yield* countStaleFilesFor(
            deps.repo,
            matches.map((m) => m.node.fileID),
          )
          return yield* finish(matches, {
            dispatchedTo: "codegraph_callers",
            resolvedNodeID: resolved.nodeID,
            resolvedDerivation: resolved.derivation,
            ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
            ...(matches.length === 0
              ? { _diagnostic: "no-edges-found" as const }
              : stale.stale || perFile.stale
                ? { _diagnostic: "stale-graph" as const }
                : {}),
          })
        }
        case "dependents": {
          if (!input.target) return yield* emptyFor("codegraph_dependents", "empty-target")
          const resolved = yield* resolveTarget(input.target)
          if ("_tag" in resolved) return yield* emptyFor("codegraph_dependents", "target-not-resolved")
          const result = yield* deps.analyzer
            .dependents({ nodeID: resolved.nodeID })
            .pipe(Effect.orElseSucceed(() => [] as CodegraphNode[]))
          const matches = result.map((n) => ({ node: n, derivation: resolved.derivation }))
          const perFile = yield* countStaleFilesFor(
            deps.repo,
            matches.map((m) => m.node.fileID),
          )
          return yield* finish(matches, {
            dispatchedTo: "codegraph_dependents",
            resolvedNodeID: resolved.nodeID,
            resolvedDerivation: resolved.derivation,
            ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
            ...(matches.length === 0
              ? { _diagnostic: "no-edges-found" as const }
              : stale.stale || perFile.stale
                ? { _diagnostic: "stale-graph" as const }
                : {}),
          })
        }
        case "impact": {
          if (!input.target) return yield* emptyFor("codegraph_impact", "empty-target")
          const looksLikeFilePath = /\.[a-z0-9]+$/i.test(input.target) || /[\\/]/.test(input.target)
          if (looksLikeFilePath) {
            const allFiles = yield* deps.repo.listAllFiles()
            fileIndex.byID = new Map(allFiles.map((f) => [f.id, f]))
            const sep = /[\\/]/.test(input.target) ? `[\\${"/"}]` : ""
            const fileHits = allFiles.filter((f) => f.path.endsWith(`${sep}${input.target}`))
            const fileIDs = new Set(fileHits.map((f) => f.id))
            const symbolNodes: CodegraphNode[] = []
            for (const fileID of fileIDs) {
              const fileNodes = yield* deps.repo.listNodesByFile(fileID)
              symbolNodes.push(...fileNodes.filter((n) => n.kind !== "file"))
            }
            if (symbolNodes.length === 0) {
              return yield* emptyFor("codegraph_impact", "target-not-resolved")
            }
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
                  if (!visited.has(edge.fromNodeID)) {
                    visited.add(edge.fromNodeID)
                    nextIDs.push(edge.fromNodeID)
                  }
                }
                if (nextIDs.length > 0) {
                  const nodes = yield* deps.repo.nodesByIDs([...new Set(nextIDs)])
                  for (const n of nodes) {
                    if (seen.has(n.id)) continue
                    seen.add(n.id)
                    const bucket = dependents.length < limit ? dependents : transitive
                    bucket.push(n)
                  }
                }
                frontier = nextIDs
              }
              return { dependents, transitive }
            })
            const matches: MatchEntry[] = [
              ...aggregated.dependents.map((n) => ({ node: n, derivation: "name-exact" as const })),
              ...aggregated.transitive.map((n) => ({ node: n, derivation: "name-exact" as const })),
            ].slice(0, limit)
            const perFile = yield* countStaleFilesFor(
              deps.repo,
              matches.map((m) => m.node.fileID),
            )
            return yield* finish(matches, {
              dispatchedTo: "codegraph_impact",
              resolvedDerivation: "name-exact",
              ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
              ...(matches.length === 0
                ? { _diagnostic: "no-edges-found" as const }
                : stale.stale || perFile.stale
                  ? { _diagnostic: "stale-graph" as const }
                  : {}),
            })
          }
          const resolved = yield* resolveTarget(input.target)
          if ("_tag" in resolved) return yield* emptyFor("codegraph_impact", "target-not-resolved")
          const result = yield* deps.analyzer
            .impact({ nodeID: resolved.nodeID })
            .pipe(Effect.orElseSucceed(() => ({ dependents: [] as CodegraphNode[], transitive: [] as CodegraphNode[] })))
          const matches: MatchEntry[] = [
            ...result.dependents.map((n) => ({ node: n, derivation: resolved.derivation })),
            ...result.transitive.map((n) => ({ node: n, derivation: resolved.derivation })),
          ].slice(0, limit)
          const perFile = yield* countStaleFilesFor(
            deps.repo,
            matches.map((m) => m.node.fileID),
          )
          return yield* finish(matches, {
            dispatchedTo: "codegraph_impact",
            resolvedNodeID: resolved.nodeID,
            resolvedDerivation: resolved.derivation,
            ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
            ...(matches.length === 0
              ? { _diagnostic: "no-edges-found" as const }
              : stale.stale || perFile.stale
                ? { _diagnostic: "stale-graph" as const }
                : {}),
          })
        }
        case "find_file": {
          const target = input.target ?? ""
          if (!target) return yield* emptyFor("codegraph_query", "empty-target")
          const allFiles = yield* deps.repo.listAllFiles()
          fileIndex.byID = new Map(allFiles.map((f) => [f.id, f]))
          const looksLikeFilename =
            /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|sql|py|pyw|go|rs|java|kt|c|cpp|cc|cxx|h|hpp|hh|css|html|sh|ps1|vue|svelte|mdx)$/i.test(
              target,
            )
          const sep = /[\\/]/.test(target) ? `[\\${"/"}]` : ""
          let files: { path: string }[]
          let matches: MatchEntry[]
          let dispatchedTo: string
          let matchedFileIDs: ReadonlyArray<string> = []
          if (looksLikeFilename || sep !== "") {
            const pathFiltered = allFiles.filter((f) => f.path.endsWith(`${sep}${target}`)).slice(0, limit)
            files = pathFiltered.map((f) => ({ path: f.path }))
            const fileIDs = new Set(pathFiltered.map((f) => f.id))
            matchedFileIDs = [...fileIDs]
            const symbolMatches: CodegraphNode[] = []
            for (const fileID of fileIDs) {
              const fileNodes = yield* deps.repo.searchNodesLight({ fileID, limit })
              symbolMatches.push(...(fileNodes as CodegraphNode[]))
            }
            const fileKindNodes = yield* deps.repo.searchNodesLight({ name: target, limit })
            symbolMatches.push(...(fileKindNodes as CodegraphNode[]).filter((n) => n.kind === "file" && n.name === target))
            matches = symbolMatches.slice(0, limit).map((n) => ({ node: n, derivation: "name-exact" as const }))
            dispatchedTo = files.length > 0 ? "graph" : "glob"
          } else {
            const symbolMatches = (yield* deps.repo.searchNodesLight({ name: target, limit }))
              .filter((n) => n.kind !== "file" && n.name === target)
              .map((n) => n as CodegraphNode)
            const fileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
            matchedFileIDs = fileIDs
            files = allFiles
              .filter((f) => fileIDs.includes(f.id))
              .slice(0, limit)
              .map((f) => ({ path: f.path }))
            matches = symbolMatches.slice(0, limit).map((n) => ({ node: n, derivation: "name-exact" as const }))
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
          return yield* finish(matches, {
            files,
            dispatchedTo,
            ...(perFile.staleFiles > 0 ? { staleFiles: perFile.staleFiles } : {}),
            ...(stale.stale || perFile.stale ? { _diagnostic: "stale-graph" as const } : {}),
          })
        }
      }
    }).pipe(Effect.mapError((err: unknown) => (err instanceof Tool.Error ? err : new Tool.Error({ message: `code_find failed for intent=${input.intent}` }))))
  },
})
