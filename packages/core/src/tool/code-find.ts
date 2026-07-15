export * as CodeFindTool from "./code-find"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { Banyan, isStale } from "../banyancode"
import { traced } from "../observability/trace"
import { CodegraphNodeSchema, GraphMeta } from "../banyancode/types"
import type { CodegraphNode } from "../banyancode/types"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { defaultLayer as codegraphAnalyzerLayer } from "../banyancode/codegraph-analyzer"
import { defaultLayer as symbolResolverLayer } from "../banyancode/symbol-resolver"
import { resolveGraphTargetPure } from "../banyancode/symbol-resolver"
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

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return

    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const repo = yield* Banyan.CodegraphRepo
    const analyzer = yield* Banyan.CodegraphAnalyzer

    yield* tools.register({
      [name]: Tool.make({
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
          "  is enabled when the symbol is not found by name. Set to false to opt out.",
        contract: { visibility: "public" },
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => {
          const fallbackDerivation = output.resolvedDerivation
            && !["name-exact", "qualified-split"].includes(output.resolvedDerivation)
            ? output.resolvedDerivation
            : undefined
          const headerParts = [
            fallbackDerivation ? `FALLBACK MATCH (derivation=${fallbackDerivation}) -- verify before treating as the exact symbol` : null,
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
          const matchesBlock = output.matches.length > 0 ? formatNodes(nodeList, "Matches") : "Matches: none."
          const filesBlock = output.files.length > 0
            ? `Files (${output.files.length}):\n${output.files.map((f) => `  ${f.path}`).join("\n")}`
            : "Files: none."
          return [{ type: "text", text: `${header}\n\n${matchesBlock}\n\n${filesBlock}` }]
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
              yield* permission.assert({
                action: name,
                resources: [input.target],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const metaRow = yield* repo.getMeta()
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
              const staleDiagnostic = stale.stale ? ("stale-graph" as const) : undefined

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
                  const result = yield* resolveGraphTargetPure(repo, { target, limit })
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
                  return {
                    matches: matches.slice(0, limit),
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_query",
                    resolvedNodeID: resolved.nodeID,
                    resolvedDerivation: resolved.derivation,
                    ...(staleDiagnostic ? { _diagnostic: staleDiagnostic } : {}),
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
                  const result = yield* analyzer.callers({ nodeID: resolved.nodeID }).pipe(
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
                  const _diagnostic = isEmpty ? ("no-edges-found" as const) : staleDiagnostic ?? undefined
                  return {
                    matches,
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_callers",
                    resolvedNodeID: resolved.nodeID,
                    resolvedDerivation: resolved.derivation,
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
                  const result = yield* analyzer.dependents({ nodeID: resolved.nodeID }).pipe(
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
                  const _diagnostic = isEmpty ? ("no-edges-found" as const) : staleDiagnostic ?? undefined
                  return {
                    matches,
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_dependents",
                    resolvedNodeID: resolved.nodeID,
                    resolvedDerivation: resolved.derivation,
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
                  const result = yield* analyzer.impact({ nodeID: resolved.nodeID }).pipe(
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
                  const _diagnostic = isEmpty ? ("no-edges-found" as const) : staleDiagnostic ?? undefined
                  return {
                    matches,
                    files: [],
                    meta,
                    intent: input.intent,
                    dispatchedTo: "codegraph_impact",
                    resolvedNodeID: resolved.nodeID,
                    resolvedDerivation: resolved.derivation,
                    ...(_diagnostic ? { _diagnostic } : {}),
                  }
                }
                case "find_file": {
                  const target = input.target ?? ""
                  if (!target) return { matches: [], files: [], meta, intent: input.intent, dispatchedTo: "codegraph_query", _diagnostic: "empty-target" as const }
                  const allFiles = yield* repo.listAllFiles()
                  const allNodes = yield* repo.listAllNodes()

                  const looksLikeFilename = /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|sql|py|pyw|go|rs|java|kt|c|cpp|cc|cxx|h|hpp|hh|css|html|sh|ps1|vue|svelte|mdx)$/i.test(target)
                  const sep = /[\\/]/.test(target) ? `[\\${"/"}]` : ""

                  let files: { path: string }[]
                  let matches: { node: CodegraphNode; derivation: ResolutionDerivation }[]
                  let dispatchedTo: string

                  if (looksLikeFilename || sep !== "") {
                    const pathFiltered = allFiles.filter((f) => f.path.endsWith(`${sep}${target}`)).slice(0, limit)
                    files = pathFiltered.map((f) => ({ path: f.path }))
                    const fileIDs = new Set(pathFiltered.map((f) => f.id))
                    const symbolMatches = allNodes.filter((n) =>
                      fileIDs.has(n.fileID) || (n.kind === "file" && n.name === target)
                    )
                    matches = symbolMatches.slice(0, limit).map((n) => ({ node: n, derivation: "name-exact" as const }))
                    dispatchedTo = files.length > 0 ? "graph" : "glob"
                  } else {
                    const symbolMatches = allNodes.filter((n) => n.kind !== "file" && n.name === target)
                    const fileIDs = [...new Set(symbolMatches.map((n) => n.fileID))]
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

                  return {
                    matches,
                    files,
                    meta,
                    intent: input.intent,
                    dispatchedTo,
                    ...(staleDiagnostic ? { _diagnostic: staleDiagnostic } : {}),
                  }
                }
              }
            }),
          ).pipe(Effect.mapError((err) => {
            if (err instanceof ToolFailure) return err
            return new ToolFailure({ message: `code_find failed for intent=${input.intent}` })
          }))
        },
      }),
    })
  }),
).pipe(Layer.provide(codegraphAnalyzerLayer), Layer.provide(symbolResolverLayer))
