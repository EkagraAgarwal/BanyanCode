export * as TreeSitter from "./tree-sitter"

import { Context, Effect, Layer, Ref } from "effect"
import path from "node:path"
import * as fs from "node:fs/promises"
import { fileURLToPath } from "node:url"

// `path` is imported for backward-compat with source-tree test mocks that
// resolve wasm assets via the original `path.resolve(import.meta.dir, …)`
// helper. The runtime init below no longer reads from disk, so `path` is
// unused at runtime; keep it for tests.
void path

// Static, literal wasm imports so Bun's bundler can include the assets in
// `bun build --compile` binaries. Variable-specifier dynamic imports
// (`import(variable, { with: ... })`) are not statically analyzable and
// therefore not embeddable — they fall back to runtime resolution and fail
// inside compiled binaries. The module loader still returns a path string
// (not raw bytes) because we ask for `type: "wasm"`; see
// `resolveAssetPath` for the absolute-path conversion.
// @ts-ignore Bun's `with: { type: "wasm" }` import attribute is not part of
// the typescript module declaration surface for these npm packages.
import treeSitterMainWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterTypescriptWasm from "tree-sitter-typescript/tree-sitter-typescript.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterJavascriptWasm from "tree-sitter-javascript/tree-sitter-javascript.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterPythonWasm from "tree-sitter-python/tree-sitter-python.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterRustWasm from "tree-sitter-rust/tree-sitter-rust.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterGoWasm from "tree-sitter-go/tree-sitter-go.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterCWasm from "tree-sitter-c/tree-sitter-c.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterCppWasm from "tree-sitter-cpp/tree-sitter-cpp.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterJavaWasm from "tree-sitter-java/tree-sitter-java.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterCSharpWasm from "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterRubyWasm from "tree-sitter-ruby/tree-sitter-ruby.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterPhpWasm from "tree-sitter-php/tree-sitter-php_only.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterBashWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterJsonWasm from "tree-sitter-json/tree-sitter-json.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterZigWasm from "@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterTomlWasm from "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm" with { type: "wasm" }
// @ts-ignore same rationale as the main wasm import above.
import treeSitterYamlWasm from "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm" with { type: "wasm" }

export const TREE_SITTER_WASM_SOURCES = Object.freeze({
  main: treeSitterMainWasm,
  typescript: treeSitterTypescriptWasm,
  javascript: treeSitterJavascriptWasm,
  python: treeSitterPythonWasm,
  rust: treeSitterRustWasm,
  go: treeSitterGoWasm,
  c: treeSitterCWasm,
  cpp: treeSitterCppWasm,
  java: treeSitterJavaWasm,
  csharp: treeSitterCSharpWasm,
  ruby: treeSitterRubyWasm,
  php: treeSitterPhpWasm,
  bash: treeSitterBashWasm,
  json: treeSitterJsonWasm,
  zig: treeSitterZigWasm,
  toml: treeSitterTomlWasm,
  yaml: treeSitterYamlWasm,
})

// Extension groups per grammar family. `main` is the web-tree-sitter runtime,
// not a language, so it is deliberately absent. One shared Parser instance
// per family keeps `parseIncremental` (parser.parse(content, oldTree)) valid
// across all extensions of the same grammar.
const GRAMMAR_EXTENSIONS: Readonly<
  Record<Exclude<keyof typeof TREE_SITTER_WASM_SOURCES, "main">, readonly string[]>
> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyw"],
  rust: [".rs"],
  go: [".go"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  java: [".java"],
  csharp: [".cs"],
  ruby: [".rb"],
  php: [".php"],
  bash: [".sh", ".bash"],
  json: [".json"],
  zig: [".zig"],
  toml: [".toml"],
  yaml: [".yml", ".yaml"],
}

export const HEAP_INITIAL_PAGES = 256
export const HEAP_MAX_PAGES = 4096

type GrammarKey = Exclude<keyof typeof TREE_SITTER_WASM_SOURCES, "main">

// Reverse index: extension → grammar family. Built once at module load from
// the static GRAMMAR_EXTENSIONS table (no sibling-namespace reads, so no
// module-cycle TDZ risk). Drives per-language lazy loads.
const GRAMMAR_BY_EXT: ReadonlyMap<string, GrammarKey> = (() => {
  const map = new Map<string, GrammarKey>()
  for (const [grammar, exts] of Object.entries(GRAMMAR_EXTENSIONS) as Array<[GrammarKey, readonly string[]]>) {
    for (const ext of exts) map.set(ext, grammar)
  }
  return map
})()

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyw",
  ".rs", ".go", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
  ".java", ".cs", ".rb", ".php", ".sh", ".bash", ".json", ".zig", ".toml", ".yml", ".yaml",
])

export interface ParseTree {
  rootNode: {
    childCount: number
    namedChildCount: number
    toString: () => string
  } | null
}

export class TreeSitterUnavailableError extends Error {
  readonly _tag = "TreeSitterUnavailableError" as const
  readonly initCause: string
  constructor(initCause: string) {
    super(`tree-sitter unavailable: ${initCause}`)
    this.initCause = initCause
  }
}

interface LoadedParserBundle {
  readonly Parser: typeof import("web-tree-sitter").Parser
  readonly Language: typeof import("web-tree-sitter").Language
  readonly Query: typeof import("web-tree-sitter").Query
  // Resolved wasm asset paths per grammar family (runtime init only; the
  // grammar itself loads on first use via ensureGrammarForExt).
  readonly assetPaths: ReadonlyMap<GrammarKey, string>
  // Lazily populated per encountered language: one shared Parser per
  // grammar family (keeps incremental oldTree reuse valid) plus its
  // Language. Mutated only by ensureGrammarForExt.
  readonly parsersByExt: Map<string, import("web-tree-sitter").Parser>
  readonly languagesByExt: Map<string, unknown>
}

export type TreeSitterState =
  | { readonly _tag: "uninitialized" }
  | { readonly _tag: "ready"; readonly parser: LoadedParserBundle }
  | { readonly _tag: "unavailable"; readonly cause: string }

const treeSitterStateRef: Ref.Ref<TreeSitterState> = Ref.makeUnsafe<TreeSitterState>({ _tag: "uninitialized" })

export { treeSitterStateRef }

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// `path.resolve(import.meta.dir, …)` is virtualized inside a `bun build --compile`
// binary, so the resolver escapes to the drive root and `Language.load` ends
// up pointing at a non-existent file. Bun's `import("…/*.wasm", { with: { type: "wasm" } })`
// resolves wasm paths against the bundle root in compiled binaries and on
// disk in dev. The static literal imports at the top of this file give Bun a
// discoverable edge so the assets are bundled; we feed the resulting path to
// `Parser.init({ locateFile })` and `Language.load(path)` — the same pattern
// `packages/opencode/src/tool/shell.ts:317-336` uses for its shell parser.
const resolveAssetPath = (asset: string): string => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

export const ensureWebTreeSitterReady = (): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(treeSitterStateRef)
    if (current._tag === "ready") return

    // Honor the legacy `TREE_SITTER_WASM_PATH` env var as an override hook
    // for tests. When set to a non-existent path the init must short-circuit
    // to the "unavailable" state instead of crashing the layer.
    const override = process.env.TREE_SITTER_WASM_PATH
    if (override !== undefined) {
      const probe = yield* Effect.tryPromise({
        try: () => fs.readFile(override),
        catch: describeError,
      }).pipe(Effect.option)
      if (probe._tag === "None") {
        const reason = `TREE_SITTER_WASM_PATH=${override} unreadable`
        yield* Effect.logWarning(`tree-sitter init: ${reason}`)
        yield* Ref.set(treeSitterStateRef, { _tag: "unavailable", cause: reason })
        return
      }
    }

    const newState = yield* Effect.tryPromise({
      try: async () => {
        // Runtime-only init: resolve the main runtime asset + every grammar
        // asset PATH, init the Parser runtime, and stop. Grammars load
        // lazily per encountered language via ensureGrammarForExt so a
        // Python-only repo never pays for the other 15 grammars' wasm
        // instantiation. `await asset` inside the map normalizes thenables —
        // the same semantics as the original per-entry Promise.resolve
        // wrapper — then each asset path is converted for Language.load.
        const entries = await Promise.all(
          (Object.entries(TREE_SITTER_WASM_SOURCES) as Array<[keyof typeof TREE_SITTER_WASM_SOURCES, string]>).map(
            async ([key, asset]) => [key, resolveAssetPath(await asset)] as const,
          ),
        )
        const mainEntry = entries.find(([key]) => key === "main")
        if (!mainEntry) throw new Error("tree-sitter main wasm asset missing")
        const mainPath = mainEntry[1]

        const webTreeSitter = await import("web-tree-sitter")
        await webTreeSitter.Parser.init({
          locateFile() {
            return mainPath
          },
        })

        const assetPaths = new Map<GrammarKey, string>()
        for (const [key, assetPath] of entries) {
          if (key === "main") continue
          assetPaths.set(key as GrammarKey, assetPath)
        }

        return {
          Parser: webTreeSitter.Parser,
          Language: webTreeSitter.Language,
          Query: webTreeSitter.Query,
          assetPaths,
          parsersByExt: new Map<string, import("web-tree-sitter").Parser>(),
          languagesByExt: new Map<string, unknown>(),
        } satisfies LoadedParserBundle
      },
      catch: describeError,
    }).pipe(
      Effect.match({
        onFailure: (cause): TreeSitterState => ({ _tag: "unavailable", cause }),
        onSuccess: (parser): TreeSitterState => ({ _tag: "ready", parser }),
      }),
    )

    if (newState._tag === "unavailable") {
      yield* Effect.logWarning(`tree-sitter init failed: ${newState.cause}`)
    }

    yield* Ref.set(treeSitterStateRef, newState)
  })

export const _resetTreeSitterStateForTesting = (): Effect.Effect<void, never, never> =>
  Ref.set(treeSitterStateRef, { _tag: "uninitialized" })

// Lazy per-language grammar load. The first parse of an encountered language
// instantiates its wasm grammar + one shared family Parser; every later
// parse of the same family reuses them. Concurrent first-use races are
// benign: the loser detects the winner's registration and drops its own
// handles without publishing them. Failures surface as
// TreeSitterUnavailableError so callers fall back to the regex parser.
export const ensureGrammarForExt = (
  ext: string,
): Effect.Effect<void, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(treeSitterStateRef)
    if (state._tag !== "ready") {
      return yield* Effect.fail(
        new TreeSitterUnavailableError(
          state._tag === "unavailable" ? state.cause : "tree-sitter not yet initialized",
        ),
      )
    }
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return yield* Effect.fail(new TreeSitterUnavailableError(`Unsupported extension: ${ext}`))
    }
    if (state.parser.languagesByExt.has(ext)) return
    const grammar = GRAMMAR_BY_EXT.get(ext)
    if (!grammar) {
      return yield* Effect.fail(new TreeSitterUnavailableError(`No grammar for: ${ext}`))
    }
    const assetPath = state.parser.assetPaths.get(grammar)
    if (!assetPath) {
      return yield* Effect.fail(new TreeSitterUnavailableError(`No wasm asset for grammar: ${grammar}`))
    }
    const language = yield* Effect.tryPromise({
      try: () => state.parser.Language.load(assetPath),
      catch: (cause) => new TreeSitterUnavailableError(describeError(cause)),
    })
    // Lost a first-use race: the winner already published this family.
    if (state.parser.languagesByExt.has(ext)) return
    // One shared Parser per grammar family so incremental parses
    // (parser.parse(content, oldTree)) stay valid across every extension
    // mapped to the same language.
    const parser = new state.parser.Parser()
    parser.setLanguage(language as import("web-tree-sitter").Language)
    for (const familyExt of GRAMMAR_EXTENSIONS[grammar]) {
      state.parser.parsersByExt.set(familyExt, parser)
      state.parser.languagesByExt.set(familyExt, language)
    }
  })

export const withTreeSitter = <A>(
  f: (state: Extract<TreeSitterState, { _tag: "ready" }>) => A,
): Effect.Effect<A, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(treeSitterStateRef)
    if (state._tag !== "ready") {
      return yield* Effect.fail(
        new TreeSitterUnavailableError(
          state._tag === "unavailable" ? state.cause : "tree-sitter not yet initialized",
        ),
      )
    }
    return yield* Effect.sync(() => f(state))
  })

export type IncrementalTree = import("web-tree-sitter").Tree

// Incremental re-parse against a previous tree. Ownership audit:
// - The dedicated Parser is allocated per call and deleted in `finally` —
//   it never escapes, so per-call parser natives cannot accumulate.
// - The returned new Tree is owned by the CALLER: adopt it and delete the
//   superseded oldTree (web-tree-sitter does not consume oldTree; both
//   remain live until deleted).
// - On failure (null parse) the oldTree is untouched and stays caller-owned.
export const parseIncremental = (
  ext: string,
  content: string,
  oldTree: IncrementalTree | undefined,
): Effect.Effect<IncrementalTree, TreeSitterUnavailableError, never> =>
  Effect.gen(function* () {
    yield* ensureGrammarForExt(ext)
    const state = yield* Ref.get(treeSitterStateRef)
    if (state._tag !== "ready") {
      return yield* Effect.fail(
        new TreeSitterUnavailableError(
          state._tag === "unavailable" ? state.cause : "tree-sitter not yet initialized",
        ),
      )
    }
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported extension: ${ext}`)
    }
    const language = state.parser.languagesByExt.get(ext) as import("web-tree-sitter").Language | undefined
    if (!language) throw new Error(`No language for: ${ext}`)
    const parser = new state.parser.Parser()
    try {
      parser.setLanguage(language)
      const tree = (oldTree ? parser.parse(content, oldTree) : parser.parse(content)) as IncrementalTree | null
      if (!tree) throw new Error(`parse returned null for: ${ext}`)
      return tree
    } finally {
      parser.delete()
    }
  })

export interface Interface {
  readonly getLanguage: (ext: string) => Effect.Effect<unknown, TreeSitterUnavailableError, never>
  readonly parse: (ext: string, content: string) => Effect.Effect<ParseTree, TreeSitterUnavailableError, never>
  readonly ensureReady: () => Effect.Effect<void, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/TreeSitterLoader") {}

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Defensive catchCause: per AGENTS.md "Tree-sitter layer wasm imports
    // must tolerate runtime module-load failure" — even if
    // ensureWebTreeSitterReady throws a defect (e.g. an unexpected sync
    // throw inside the wasm-loader try callback), the layer must
    // construct successfully. parse() then surfaces
    // TreeSitterUnavailableError at use time. catchCause (not catchAll)
    // because effect-smol has no catchAll — and catchCause also catches
    // defects, which is what we want here: the layer must NOT surface a
    // defect on construction. The state ref is left in its prior state
    // (typically "unavailable") and re-attempts are idempotent.
    yield* ensureWebTreeSitterReady().pipe(
      Effect.catchCause(() => Effect.void),
    )

    const getLanguage = (ext: string): Effect.Effect<unknown, TreeSitterUnavailableError, never> =>
      Effect.gen(function* () {
        yield* ensureGrammarForExt(ext)
        return yield* withTreeSitter((state) => {
          if (!SUPPORTED_EXTENSIONS.has(ext)) {
            throw new Error(`Unsupported extension: ${ext}. Tree-sitter grammar loaded for this extension (16 languages; see SUPPORTED_EXTENSIONS).`)
          }
          const language = state.parser.languagesByExt.get(ext)
          if (language === undefined) throw new Error(`No language for: ${ext}`)
          return language
        })
      })

    const parse = (ext: string, content: string): Effect.Effect<ParseTree, TreeSitterUnavailableError, never> =>
      Effect.gen(function* () {
        yield* ensureGrammarForExt(ext)
        return yield* withTreeSitter((state) => {
          if (!SUPPORTED_EXTENSIONS.has(ext)) {
            throw new Error(`Unsupported extension: ${ext}. Tree-sitter grammar loaded for this extension (16 languages; see SUPPORTED_EXTENSIONS).`)
          }
          const parser = state.parser.parsersByExt.get(ext)
          if (!parser) throw new Error(`No parser for: ${ext}`)
          // The shared family Parser stays alive across calls; the per-parse
          // Tree is deleted in `finally` once its snapshot is extracted.
          const tree = parser.parse(content)
          try {
            const rootNode = tree?.rootNode ?? null
            return {
              rootNode: rootNode
                ? {
                    childCount: rootNode.childCount,
                    namedChildCount: rootNode.namedChildCount,
                    toString: () => rootNode.toString(),
                  }
                : null,
            } as ParseTree
          } finally {
            tree?.delete()
          }
        })
      })

    const ensureReady = (): Effect.Effect<void, never, never> => ensureWebTreeSitterReady()

    return { getLanguage, parse, ensureReady } satisfies Interface
  }),
)

export {
  parseTypeScriptWithTreeSitter,
  parsePythonWithTreeSitter,
  validateQueryFile,
  QUERY_FILES,
} from "./query-executor"
