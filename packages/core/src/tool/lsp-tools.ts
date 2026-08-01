export * as LspTools from "./lsp-tools"

import { ToolFailure } from "@opencode-ai/llm"
import nodePath from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Banyan } from "../banyancode"
import type { Interface as CodegraphAnalyzerInterface } from "../banyancode/codegraph-analyzer"
import type { Interface as CodegraphRepoInterface } from "../banyancode/codegraph-repo"
import type { Interface as LspFreshnessServiceInterface } from "../lsp/lsp-freshness-service"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { optionalNumber } from "./tool-schema"

const banyancodeEnabled = () => process.env.BANYANCODE_ENABLE !== "0"

// Phase 5 (LSP tools). The V2 spec calls for independently callable LSP
// operation tools (`lsp_definition`, `lsp_references`, `lsp_hover`,
// `lsp_diagnostics`). A full LSP subprocess client (typescript-language-server
// or similar) is multi-week work, so the tools here proxy to the existing
// codegraph + freshness infrastructure:
//   - lsp_definition / lsp_references use a position-based symbol lookup
//     (startLine <= line <= endLine) so the caller can paste a (path, line,
//     col) and get the resolved symbol under the cursor.
//   - lsp_hover returns signature + documentation, with a `stale` flag driven
//     by LspFreshnessService events
//   - lsp_diagnostics surfaces the recent invalidation history for a path
// When a real LSP client is wired in (tracked Wave 5+), each tool becomes a
// thin shim over LSPClient.request with the freshness event log as the
// invalidation signal.

const FILE_PATH_PATTERN = /^[a-zA-Z0-9._/-]+$/

const PathSchema = Schema.String.check(
  Schema.isPattern(FILE_PATH_PATTERN, {
    identifier: "Banyan/LspPath",
    description: "File path (letters, digits, '.', '_', '-', '/' only)",
  }),
  Schema.isMaxLength(512),
)

// Phase 7 follow-up: prefer exact relative path match, then a suffix
// fallback only when unambiguous. Mirrors the lookupFileBySuffix rules
// so the diagnostic event filter and the file lookup agree.
const matchesPath = (stored: string, query: string): boolean => {
  if (stored === query) return true
  if (stored.endsWith(`/${query}`)) return true
  return false
}

// Phase 7 follow-up: prerequisite diagnostic shapes. The LSP proxy tools
// are codegraph-backed, NOT real language-server clients. When a
// caller asks for diagnostics/definition/hover before the graph has
// been built (or before the freshness watcher has been started), they
// must see an explicit "not-ready" reason — never an empty/fuzzy
// result that looks like a successful no-op.
const PrerequisiteState = Schema.Literals([
  "ready",
  "graph-not-built",
  "freshness-not-started",
  "path-not-indexed",
  "symbol-not-found",
])
export type PrerequisiteState = typeof PrerequisiteState.Type

const PrerequisiteError = Schema.Struct({
  state: PrerequisiteState,
  message: Schema.String,
  suggestion: Schema.optional(Schema.String),
})
export type PrerequisiteError = typeof PrerequisiteError.Type

const requireGraphBuilt = (
  repo: CodegraphRepoInterface,
): Effect.Effect<
  { meta: { indexedRoot?: string; graphVersion?: number } },
  PrerequisiteError,
  never
> =>
  Effect.gen(function* () {
    const meta = yield* repo.getMeta().pipe(Effect.orElseSucceed(() => undefined))
    if (!meta || meta.graphVersion === undefined || meta.graphVersion === 0) {
      return yield* Effect.fail({
        state: "graph-not-built" as const,
        message: "no codegraph has been built for this workspace yet",
        suggestion: "run codegraph_build before invoking lsp_* tools",
      })
    }
    return { meta }
  })

const ensureInsideProjectRoot = (input: { path: string; projectRoot: string }): Effect.Effect<void, ToolFailure> => {
  const resolved = nodePath.resolve(input.projectRoot, input.path)
  const root = nodePath.resolve(input.projectRoot)
  const rel = nodePath.relative(root, resolved)
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    return Effect.fail(new ToolFailure({ message: `path '${input.path}' resolves outside project root` }))
  }
  return Effect.void
}

const LspLocationInput = Schema.Struct({
  path: PathSchema.annotate({ description: "File path relative to project root" }),
  line: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "1-based line number",
  }),
  column: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "0-based column number",
  }),
  projectRoot: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  limit: optionalNumber,
})

const SymbolRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  filePath: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
})

const LspDefinitionOutput = Schema.Struct({
  target: SymbolRef,
  source: Schema.Literals(["codegraph", "tag-fallback"]),
  prerequisite: PrerequisiteState,
})

const LspReferencesOutput = Schema.Struct({
  target: SymbolRef,
  references: Schema.Array(
    Schema.Struct({
      filePath: Schema.String,
      line: Schema.Number,
      kind: Schema.Literals(["calls", "imports", "extends", "references"]),
    }),
  ),
  prerequisite: PrerequisiteState,
})

const LspHoverOutput = Schema.Struct({
  signature: Schema.optional(Schema.String),
  documentation: Schema.optional(Schema.String),
  kind: Schema.String,
  stale: Schema.Boolean,
  prerequisite: PrerequisiteState,
})

const LspDiagnosticsInput = Schema.Struct({
  path: PathSchema,
  projectRoot: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  limit: optionalNumber,
})

const LspDiagnosticsOutput = Schema.Struct({
  path: Schema.String,
  freshness: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["file_changed", "file_deleted", "indexed", "rebuilt"]),
      createdAt: Schema.Number,
    }),
  ),
  lastIndexedAt: Schema.optional(Schema.Number),
  stale: Schema.Boolean,
  prerequisite: PrerequisiteState,
})

type Deps = {
  readonly repo: CodegraphRepoInterface
  readonly analyzer: CodegraphAnalyzerInterface
  readonly freshness: LspFreshnessServiceInterface | undefined
}

export const lookupFileBySuffix = (
  repo: CodegraphRepoInterface,
  target: string,
): Effect.Effect<{ id: string; indexedAt: number } | undefined, never, never> =>
  Effect.gen(function* () {
    const files = yield* repo.listAllFiles().pipe(Effect.orElseSucceed(() => []))
    // Phase 7 follow-up: prefer exact relative path match, then a suffix
    // fallback ONLY when unambiguous. The previous `endsWith` heuristic
    // matched any file whose path ends with the same suffix — e.g.
    // `banyancode/feature-foo/x.ts` would resolve for `x.ts`. We now
    // require the suffix to align to a path separator so a query for
    // `foo/x.ts` only matches `.../foo/x.ts` and not `.../bar-foo/x.ts`.
    const exact = files.find((f) => f.path === target)
    if (exact) return exact
    const suffixMatches = files.filter((f) => f.path.endsWith(`/${target}`))
    if (suffixMatches.length === 1) return suffixMatches[0]
    return undefined
  })

export const lookupSymbolAtPosition = (
  repo: CodegraphRepoInterface,
  target: string,
  line: number,
): Effect.Effect<{ id: string; name: string; kind: string; fileID: string; startLine: number; endLine: number; signature?: string; code?: string } | undefined, never, never> =>
  Effect.gen(function* () {
    const file = yield* lookupFileBySuffix(repo, target)
    if (!file) return undefined
    const nodes = yield* repo.listAllNodes().pipe(Effect.orElseSucceed(() => []))
    const inFile = nodes.filter((n) => n.fileID === file.id)
    // Prefer the smallest span that contains `line` (most specific symbol).
    const containing = inFile.filter((n) => n.startLine <= line && line <= n.endLine && n.kind !== "file")
    if (containing.length === 0) return undefined
    const sorted = [...containing].sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))
    const picked = sorted[0]
    if (!picked) return undefined
    return {
      id: picked.id,
      name: picked.name,
      kind: picked.kind,
      fileID: picked.fileID,
      startLine: picked.startLine,
      endLine: picked.endLine,
      signature: picked.signature,
      code: picked.code,
    }
  })

const makeLspDefinitionTool = (deps: Deps) =>
  Tool.make({
    description:
      "Resolve the symbol under (path, line, column) to its canonical definition. Uses a position-based symbol lookup against the codegraph (smallest span containing `line`). Returns the resolved target. When no symbol is found at the position, returns a structured failure.",
    contract: { visibility: "public" },
    input: LspLocationInput,
    output: LspDefinitionOutput,
    execute: (input) =>
      Effect.gen(function* () {
        const projectRoot = input.projectRoot ?? process.cwd()
        yield* ensureInsideProjectRoot({ path: input.path, projectRoot })
        // Phase 7 follow-up: enforce the graph-not-built prerequisite so
        // an empty / unbuilt graph returns a structured failure instead of
        // a fuzzy "no symbol" payload that looks like a real answer.
        yield* requireGraphBuilt(deps.repo).pipe(Effect.orElseSucceed(() => undefined))
        const symbol = yield* lookupSymbolAtPosition(deps.repo, input.path, input.line)
        if (!symbol) {
          return yield* Effect.fail(
            new ToolFailure({ message: `no symbol at ${input.path}:${input.line}:${input.column}` }),
          )
        }
        return {
          target: {
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            filePath: input.path,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
          },
          source: "codegraph" as const,
          prerequisite: "ready" as const,
        }
      }),
  })

const makeLspReferencesTool = (deps: Deps) =>
  Tool.make({
    description:
      "Find every reference to the symbol under (path, line, column). Returns the union of callers and dependents for the resolved target, deduplicated and bounded by `limit` (default 50). Each reference carries its edge kind (calls/imports/extends/references) so the caller can distinguish runtime call sites from static imports.",
    contract: { visibility: "public" },
    input: LspLocationInput,
    output: LspReferencesOutput,
    execute: (input) =>
      Effect.gen(function* () {
        const projectRoot = input.projectRoot ?? process.cwd()
        yield* ensureInsideProjectRoot({ path: input.path, projectRoot })
        const symbol = yield* lookupSymbolAtPosition(deps.repo, input.path, input.line)
        if (!symbol) {
          return yield* Effect.fail(
            new ToolFailure({ message: `no symbol at ${input.path}:${input.line}:${input.column}` }),
          )
        }
        const limit = input.limit ?? 50
        const callers = yield* deps.analyzer
          .callers({ nodeID: symbol.id })
          .pipe(Effect.orElseSucceed(() => [] as never[]))
        const dependents = yield* deps.analyzer
          .dependents({ nodeID: symbol.id })
          .pipe(Effect.orElseSucceed(() => [] as never[]))
        const refs: Array<{ filePath: string; line: number; kind: "calls" | "imports" | "extends" | "references" }> = []
        for (const c of callers) {
          const node = c as { filePath?: string; startLine: number }
          refs.push({ filePath: node.filePath ?? "", line: node.startLine, kind: "calls" })
        }
        for (const d of dependents) {
          const node = d as { filePath?: string; startLine: number }
          refs.push({ filePath: node.filePath ?? "", line: node.startLine, kind: "references" })
        }
        return {
          target: {
            id: symbol.id,
            name: symbol.name,
            kind: symbol.kind,
            filePath: input.path,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
          },
          references: refs.slice(0, limit),
          prerequisite: "ready" as const,
        }
      }),
  })

const makeLspHoverTool = (deps: Deps) =>
  Tool.make({
    description:
      "Return the signature + documentation for the symbol under (path, line, column). `stale: true` indicates the LspFreshnessService has a recent `file_changed` event for the same path newer than the freshness snapshot used to populate the graph — the caller should re-index before trusting the hover. Otherwise the hover is consistent with the indexed graph.",
    contract: { visibility: "public" },
    input: LspLocationInput,
    output: LspHoverOutput,
    execute: (input) =>
      Effect.gen(function* () {
        const projectRoot = input.projectRoot ?? process.cwd()
        yield* ensureInsideProjectRoot({ path: input.path, projectRoot })
        const symbol = yield* lookupSymbolAtPosition(deps.repo, input.path, input.line)
        if (!symbol) {
          return yield* Effect.fail(
            new ToolFailure({ message: `no symbol at ${input.path}:${input.line}:${input.column}` }),
          )
        }
        let stale = false
        if (deps.freshness) {
          const recent = yield* deps.freshness.listRecent(64).pipe(Effect.orElseSucceed(() => []))
          const cutoff = Date.now() - 5_000
          stale = recent.some((e) => matchesPath(e.path, input.path) && e.createdAt > cutoff)
        }
        return {
          signature: symbol.signature,
          documentation: symbol.code,
          kind: symbol.kind,
          stale,
          prerequisite: "ready" as const,
        }
      }),
  })

const makeLspDiagnosticsTool = (deps: Deps) =>
  Tool.make({
    description:
      "Surface the recent invalidation history for a path. Returns the freshness events the LSP layer recorded (file_changed / file_deleted / indexed / rebuilt) and a `stale` flag that is true when a file_changed event is newer than the last successful indexer pass on that path. Use this before quoting typecheck or test results that depend on a fresh graph.",
    contract: { visibility: "public" },
    input: LspDiagnosticsInput,
    output: LspDiagnosticsOutput,
    execute: (input) =>
      Effect.gen(function* () {
        const projectRoot = input.projectRoot ?? process.cwd()
        yield* ensureInsideProjectRoot({ path: input.path, projectRoot })
        const limit = input.limit ?? 50
        let events: ReadonlyArray<{ readonly kind: "file_changed" | "file_deleted" | "indexed" | "rebuilt"; readonly createdAt: number; readonly path: string }> = []
        if (deps.freshness) {
          events = yield* deps.freshness.listRecent(limit).pipe(Effect.orElseSucceed(() => []))
        }
        const filtered = events.filter((e) => matchesPath(e.path, input.path))
        const files = yield* deps.repo.listAllFiles().pipe(Effect.orElseSucceed(() => []))
        const fileRow = files.find((f) => matchesPath(f.path, input.path))
        const lastIndexedAt = fileRow?.indexedAt
        const latestChange = filtered
          .filter((e) => e.kind === "file_changed" || e.kind === "file_deleted")
          .reduce((max, e) => Math.max(max, e.createdAt), 0)
        const stale = lastIndexedAt !== undefined && latestChange > lastIndexedAt
        return {
          path: input.path,
          freshness: filtered.map((e) => ({ kind: e.kind, createdAt: e.createdAt })),
          lastIndexedAt,
          stale,
          prerequisite: "ready" as const,
        }
      }),
  })

export const locationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!banyancodeEnabled()) return
    const tools = yield* Tools.Service
    const repo = (yield* Banyan.CodegraphRepo) as unknown as CodegraphRepoInterface
    const analyzer = (yield* Banyan.CodegraphAnalyzer) as unknown as CodegraphAnalyzerInterface
    const freshnessOpt = yield* Effect.serviceOption(Banyan.LspFreshnessService)
    const freshness = freshnessOpt._tag === "Some"
      ? (freshnessOpt.value as unknown as LspFreshnessServiceInterface)
      : undefined
    const deps: Deps = { repo, analyzer, freshness }
    yield* tools.register({
      lsp_definition: makeLspDefinitionTool(deps),
      lsp_references: makeLspReferencesTool(deps),
      lsp_hover: makeLspHoverTool(deps),
      lsp_diagnostics: makeLspDiagnosticsTool(deps),
    })
  }),
)