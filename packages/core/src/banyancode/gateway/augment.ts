export * as RepositoryGatewayAugment from "./augment"

import { Effect, Option } from "effect"
import { Service as BanyanConfigService } from "../banyan-config"
import { Service as RepositoryIntelligence } from "../repository-intelligence"
import type { Interface as RepositoryIntelligenceInterface } from "../repository-intelligence"
import type { CodegraphNode, CodegraphNodeKind, RepositoryContext } from "../types"
import { ROUTER_IDENTITY, ROUTER_VERSION } from "./router"
import { directResult, provenanceForOperation } from "./backends"
import { formatAugmentHeader, type AugmentSymbolCounts } from "./formatter"
import type { RepositoryBackend } from "./gateway"
import type { RepositoryOperation, RepositoryResult } from "./types"

// AUGMENT backend for the RepositoryGateway (plan §6 "Phase 6+", spec §6.2 /
// §29 / §117). AUGMENT keeps the original operation (exact source still comes
// from the original tool) but OPTIONALLY appends a compact symbol header built
// from the code graph: `Symbol: <name> | Imports: <n> | References: <n> |
// Callers: <n> | Dependents: <n>`. The gateway wrapper never replaces content —
// the header is metadata only, and the header builder never fabricates counts.
//
// Fail-closed by contract (spec §35): the backend NEVER fails and NEVER
// fabricates. Any of the following resolves to a result with `route: "direct"`
// (the gateway falls through to the original tool untouched):
//   - the config gate is off (`banyancode_augment_read !== true`; spec §77),
//   - the path is not a code file (spec §117: augment reads of code only),
//   - the RepositoryIntelligence service is missing,
//   - the graph query degrades (status "failed" / no symbols),
//   - the file's main symbol cannot be resolved from the query result,
//   - any defect inside query/slice (catchCause below).

// Code file extensions. Anything else (package.json, tsconfig.json, .md,
// .yml, Dockerfile, ...) is a non-code path and never augmented (spec §6.1
// lists config/docs files as canonical DIRECT reads).
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "kt", "kts", "scala", "groovy",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "swift",
  "rb", "php", "sh", "bash", "zsh", "zig", "dart", "lua",
  "ex", "exs", "erl", "hrl", "hs", "clj", "cljs",
])

const isCodePath = (path: string): boolean => {
  const dot = path.lastIndexOf(".")
  if (dot < 0 || dot === path.length - 1) return false
  return CODE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

// "src/auth/AuthManager.ts" -> "AuthManager": the query term used to find the
// file's main symbol in the graph (§6.2 example: read src/auth/AuthManager.ts
// -> Symbol: AuthManager).
const basenameStem = (path: string): string => {
  const base = path.split(/[\\/]/).pop() ?? ""
  return base.replace(/\.[^.]+$/, "")
}

// Path equality that tolerates absolute-vs-relative and Windows backslashes:
// "src/server.ts" matches a graph row stored as "D:/repo/src/server.ts" (and
// vice versa). Suffix matching is bounded to full path segments so two files
// that merely share a basename never collide.
const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "")
const pathMatches = (requested: string, candidate: string): boolean => {
  const a = normalizePath(requested)
  const b = normalizePath(candidate)
  if (a === b) return true
  return a.endsWith("/" + b) || b.endsWith("/" + a)
}

// Prefer the most representative symbol kind for the header's `Symbol` slot:
// class > function > method > interface/type > anything else (deterministic,
// not order-dependent on the query result).
const SYMBOL_KIND_PRIORITY: Partial<Record<CodegraphNodeKind, number>> = {
  class: 0,
  function: 1,
  method: 2,
  type: 3,
}

// The file's main symbol = the highest-priority symbol whose file matches the
// requested path. Undefined when the query surfaced no symbol from this file
// (fail-closed — no fabrication, no cross-file attribution).
const mainSymbolForPath = (ctx: RepositoryContext, path: string): CodegraphNode | undefined => {
  const pathByFileID = new Map(ctx.files.map((file) => [file.id, file.path] as const))
  const inFile = ctx.symbols.filter((symbol) => pathMatches(path, pathByFileID.get(symbol.fileID) ?? ""))
  if (inFile.length === 0) return undefined
  return [...inFile].sort(
    (a, b) => (SYMBOL_KIND_PRIORITY[a.kind] ?? 99) - (SYMBOL_KIND_PRIORITY[b.kind] ?? 99),
  )[0]
}

// Config gate (plan §4 / spec §77): `banyancode_augment_read` defaults ON.
// Only an explicit `false` disables augmentation; a missing BanyanConfigService
// (serviceOption None) or an unset flag means enabled — the gateway is ON by
// default and must be opted out of explicitly.
export const augmentEnabled = (): Effect.Effect<boolean, never, never> =>
  Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(BanyanConfigService)
    if (Option.isNone(configOpt)) return true
    const config = yield* configOpt.value.get()
    return config.banyancode_augment_read !== false
  })

// Build the compact symbol header + its RepositoryResult for a code file path.
// Never fails; undefined means "no augmentation" (fail-closed).
//
// Count mapping (documented; derived from the query ctx + slice shapes, the
// same query+slice pattern the intelligence backend uses):
//   Symbol     -> the file's main symbol name (ctx.symbols, file-scoped)
//   Imports    -> slice.dependencies.length (distinct outgoing dependency
//                 names; slice.dependencies groups outgoing
//                 calls/references/imports/extends — the closest proxy for
//                 "what this file pulls in")
//   References -> ctx.graph.edges with kind "references" (reference-kind
//                 edges in the query's local edge window)
//   Callers    -> slice.directCallers.length (distinct depth-1 incoming
//                 nodes; directCallers groups calls+references,
//                 CALLER_EDGE_KINDS = { calls, references })
//   Dependents -> slice.transitiveDependents.length (depth>1 incoming nodes)
export const symbolHeaderFor = (
  path: string,
  intel: RepositoryIntelligenceInterface,
): Effect.Effect<{ readonly header: string; readonly result: RepositoryResult } | undefined, never, never> => {
  // Non-code path -> no augmentation (spec §117).
  if (!isCodePath(path)) return Effect.succeed(undefined)
  const stem = basenameStem(path)
  if (stem === "") return Effect.succeed(undefined)
  return Effect.gen(function* () {
    const ctx = yield* intel.query({ query: stem })
    // Degraded graph: no symbols -> fail closed, no augmentation.
    if (ctx.status === "failed" || ctx.symbols.length === 0) return undefined
    const slice = yield* intel.slice(ctx)
    const symbol = mainSymbolForPath(ctx, path)
    if (symbol === undefined) return undefined
    const counts: AugmentSymbolCounts = {
      symbol: symbol.name,
      imports: slice.dependencies.length,
      references: ctx.graph.edges.filter((edge) => edge.kind === "references").length,
      callers: slice.directCallers.length,
      dependents: slice.transitiveDependents.length,
    }
    const header = formatAugmentHeader(counts)
    return {
      header,
      result: {
        route: "augment",
        operation: { kind: "content", path },
        source: "codegraph",
        results: [],
        header,
        provenance: provenanceForOperation({ kind: "content", path }),
      },
    }
  })
}

// The AUGMENT backend wired into the gateway's BackendSelector. Declares
// support for every content operation (reads); per-request fail-closed
// happens inside execute(). Selected for a content operation under either an
// "augment" RouteDecision or an "intelligence" decision on a content op.
export const augmentBackend: RepositoryBackend = {
  supports: (operation) => operation.kind === "content",
  execute: (operation) =>
    Effect.gen(function* () {
      // Gate off (default) -> fail closed before touching the graph.
      if (!(yield* augmentEnabled())) return directResult(operation)
      const intelOpt = yield* Effect.serviceOption(RepositoryIntelligence)
      if (Option.isNone(intelOpt)) return directResult(operation)
      const path = operation.kind === "content" ? operation.path : ""
      const built = yield* symbolHeaderFor(path, intelOpt.value).pipe(
        // Never throw (spec §35): any defect degrades to "no augmentation".
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (built === undefined) return directResult(operation)
      // Carry the gateway's operation (the resolved semantic op) rather than
      // the builder's re-derived content op.
      return { ...built.result, operation } as RepositoryResult
    }),
}
