/**
 * tree-sitter loader for the v2 plugin.
 *
 * Ported from v1 `packages/core/src/banyancode/langs/tree-sitter.ts`. The
 * parsing logic, lazy per-family loading and LRU eviction are unchanged. What
 * differs is where the wasm bytes come from:
 *
 *   v1  — `import wasm from "tree-sitter-<lang>/…wasm" with { type: "wasm" }`
 *         for all 17 grammars (Bun embedded every one in the binary).
 *   v2  — assets live in `packages/banyancode/assets/`, resolved through the
 *         package's `#grammar-assets` conditional import (Bun build embeds the
 *         runtime + TypeScript grammar; the Node build points at the assets
 *         directory). Only `tree-sitter.wasm` and `tree-sitter-typescript.wasm`
 *         are vendored today; every other grammar resolves from the same
 *         directory by filename and reports `TreeSitterUnavailableError` (so
 *         the caller falls back to the regex parser) when the file is absent.
 *
 * Adding a grammar is therefore a pure asset drop:
 *   packages/banyancode/assets/tree-sitter-python.wasm, etc.
 * See `GRAMMAR_ASSET_FILES` for the expected filename of each language.
 */
import { Context, Effect, Layer, Ref } from "effect"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { grammarWasmPaths, runtimeWasmPath } from "#grammar-assets"

export const HEAP_INITIAL_PAGES = 256
export const HEAP_MAX_PAGES = 4096
export const MAX_HOT_GRAMMAR_FAMILIES = 4

type GrammarKey =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "c"
  | "cpp"
  | "java"
  | "csharp"
  | "ruby"
  | "php"
  | "bash"
  | "json"
  | "zig"
  | "toml"
  | "yaml"

/**
 * Asset filename per grammar family. All 16 grammars are vendored in
 * `packages/banyancode/assets/` and imported by `grammar-assets.bun.ts` so the
 * compiled binary embeds them; the Node build reads the same files from disk.
 * A missing file is a graceful per-language degradation to the regex parser,
 * never a crash.
 */
export const GRAMMAR_ASSET_FILES: Readonly<Record<GrammarKey, string>> = Object.freeze({
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php_only.wasm",
  bash: "tree-sitter-bash.wasm",
  json: "tree-sitter-json.wasm",
  zig: "tree-sitter-zig.wasm",
  toml: "tree-sitter-toml.wasm",
  yaml: "tree-sitter-yaml.wasm",
})

const GRAMMAR_EXTENSIONS: Readonly<Record<GrammarKey, readonly string[]>> = {
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

const GRAMMAR_BY_EXT: ReadonlyMap<string, GrammarKey> = (() => {
  const map = new Map<string, GrammarKey>()
  for (const [grammar, exts] of Object.entries(GRAMMAR_EXTENSIONS) as Array<[GrammarKey, readonly string[]]>) {
    for (const ext of exts) map.set(ext, grammar)
  }
  return map
})()

const SUPPORTED_EXTENSIONS = new Set(GRAMMAR_BY_EXT.keys())

/** Directory the grammar wasm files are read from. */
export const assetDirectory = (): string =>
  process.env.BANYANCODE_GRAMMAR_DIR ??
  process.env.BANYANCODE_WASM_DIR ??
  process.env.OPENCODE_NODE_ASSETS_DIR ??
  dirname(runtimeWasmPath)

/**
 * Resolve the wasm path for a grammar family. Every grammar comes from the
 * bundled `#grammar-assets` map (Bun's compiled binary embeds all of them).
 * The directory overrides stay supported for the Node build and for tests that
 * stage their own wasm files.
 */
export const grammarWasmPath = (grammar: GrammarKey): string => {
  const override =
    process.env.BANYANCODE_GRAMMAR_DIR ??
    process.env.BANYANCODE_WASM_DIR ??
    process.env.OPENCODE_NODE_ASSETS_DIR
  if (override !== undefined) return join(override, GRAMMAR_ASSET_FILES[grammar])
  return grammarWasmPaths[grammar]
}

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
  readonly assetPaths: ReadonlyMap<GrammarKey, string>
  readonly parsersByExt: Map<string, import("web-tree-sitter").Parser>
  readonly languagesByExt: Map<string, unknown>
  readonly grammarUseOrder: GrammarKey[]
}

export type TreeSitterState =
  | { readonly _tag: "uninitialized" }
  | { readonly _tag: "ready"; readonly parser: LoadedParserBundle }
  | { readonly _tag: "unavailable"; readonly cause: string }

const treeSitterStateRef: Ref.Ref<TreeSitterState> = Ref.makeUnsafe<TreeSitterState>({ _tag: "uninitialized" })

export { treeSitterStateRef }

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const ensureWebTreeSitterReady = (): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(treeSitterStateRef)
    if (current._tag === "ready") return

    const override = process.env.TREE_SITTER_WASM_PATH
    if (override !== undefined) {
      const probe = yield* Effect.tryPromise({
        try: () => readFile(override),
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
        const mainPath = process.env.TREE_SITTER_WASM_PATH ?? runtimeWasmPath
        const webTreeSitter = await import("web-tree-sitter")
        // Bytes, not a path: the spike confirmed `wasmBinary` works both from
        // source and inside the compiled binary, where a raw path would not.
        await webTreeSitter.Parser.init({ wasmBinary: await readFile(mainPath) })

        const assetPaths = new Map<GrammarKey, string>()
        for (const grammar of Object.keys(GRAMMAR_EXTENSIONS) as GrammarKey[]) {
          const candidate = grammarWasmPath(grammar)
          if (existsSync(candidate)) assetPaths.set(grammar, candidate)
        }

        return {
          Parser: webTreeSitter.Parser,
          Language: webTreeSitter.Language,
          Query: webTreeSitter.Query,
          assetPaths,
          parsersByExt: new Map<string, import("web-tree-sitter").Parser>(),
          languagesByExt: new Map<string, unknown>(),
          grammarUseOrder: [],
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

const touchGrammarFamily = (bundle: LoadedParserBundle, grammar: GrammarKey): void => {
  const order = bundle.grammarUseOrder
  const at = order.indexOf(grammar)
  if (at !== -1) order.splice(at, 1)
  order.push(grammar)
}

const evictColdGrammarFamilies = (bundle: LoadedParserBundle): void => {
  while (bundle.grammarUseOrder.length >= MAX_HOT_GRAMMAR_FAMILIES) {
    const cold = bundle.grammarUseOrder.shift()
    if (cold === undefined) return
    const exts = GRAMMAR_EXTENSIONS[cold]
    const parser = bundle.parsersByExt.get(exts[0] ?? "")
    if (parser) {
      try {
        parser.delete()
      } catch {
        // Best-effort native teardown; the ext entries are dropped regardless.
      }
    }
    for (const familyExt of exts) {
      bundle.parsersByExt.delete(familyExt)
      bundle.languagesByExt.delete(familyExt)
    }
  }
}

export const ensureGrammarForExt = (ext: string): Effect.Effect<void, TreeSitterUnavailableError> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(treeSitterStateRef)
    if (state._tag !== "ready") {
      return yield* Effect.fail(
        new TreeSitterUnavailableError(state._tag === "unavailable" ? state.cause : "tree-sitter not yet initialized"),
      )
    }
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return yield* Effect.fail(new TreeSitterUnavailableError(`Unsupported extension: ${ext}`))
    }
    const grammar = GRAMMAR_BY_EXT.get(ext)!
    if (state.parser.languagesByExt.has(ext)) {
      touchGrammarFamily(state.parser, grammar)
      return
    }
    const assetPath = state.parser.assetPaths.get(grammar)
    if (!assetPath) {
      return yield* Effect.fail(
        new TreeSitterUnavailableError(
          `grammar wasm missing: ${GRAMMAR_ASSET_FILES[grammar]} (expected in ${assetDirectory()})`,
        ),
      )
    }
    const language = yield* Effect.tryPromise({
      try: () => state.parser.Language.load(assetPath),
      catch: (cause) => new TreeSitterUnavailableError(describeError(cause)),
    })
    if (state.parser.languagesByExt.has(ext)) {
      touchGrammarFamily(state.parser, grammar)
      return
    }
    evictColdGrammarFamilies(state.parser)
    const parser = new state.parser.Parser()
    parser.setLanguage(language as import("web-tree-sitter").Language)
    for (const familyExt of GRAMMAR_EXTENSIONS[grammar]) {
      state.parser.parsersByExt.set(familyExt, parser)
      state.parser.languagesByExt.set(familyExt, language)
    }
    touchGrammarFamily(state.parser, grammar)
  })

export const withTreeSitter = <A>(
  f: (state: Extract<TreeSitterState, { _tag: "ready" }>) => A,
): Effect.Effect<A, TreeSitterUnavailableError> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(treeSitterStateRef)
    if (state._tag !== "ready") {
      return yield* Effect.fail(
        new TreeSitterUnavailableError(state._tag === "unavailable" ? state.cause : "tree-sitter not yet initialized"),
      )
    }
    return yield* Effect.sync(() => f(state))
  })

export type IncrementalTree = import("web-tree-sitter").Tree

export const parseIncremental = (
  ext: string,
  content: string,
  oldTree: IncrementalTree | undefined,
): Effect.Effect<IncrementalTree, TreeSitterUnavailableError> =>
  Effect.gen(function* () {
    yield* ensureGrammarForExt(ext)
    const state = yield* Ref.get(treeSitterStateRef)
    if (state._tag !== "ready") {
      return yield* Effect.fail(
        new TreeSitterUnavailableError(state._tag === "unavailable" ? state.cause : "tree-sitter not yet initialized"),
      )
    }
    if (!SUPPORTED_EXTENSIONS.has(ext)) throw new Error(`Unsupported extension: ${ext}`)
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
  readonly getLanguage: (ext: string) => Effect.Effect<unknown, TreeSitterUnavailableError>
  readonly parse: (ext: string, content: string) => Effect.Effect<ParseTree, TreeSitterUnavailableError>
  readonly ensureReady: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/codegraph/TreeSitterLoader") {}

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Per AGENTS.md: the layer must always construct; parse() surfaces the
    // typed error at use time so a missing wasm bundle degrades to regex.
    yield* ensureWebTreeSitterReady().pipe(Effect.catchCause(() => Effect.void))

    const getLanguage = (ext: string): Effect.Effect<unknown, TreeSitterUnavailableError> =>
      Effect.gen(function* () {
        yield* ensureGrammarForExt(ext)
        return yield* withTreeSitter((state) => {
          const language = state.parser.languagesByExt.get(ext)
          if (language === undefined) throw new Error(`No language for: ${ext}`)
          return language
        })
      })

    const parse = (ext: string, content: string): Effect.Effect<ParseTree, TreeSitterUnavailableError> =>
      Effect.gen(function* () {
        yield* ensureGrammarForExt(ext)
        return yield* withTreeSitter((state) => {
          const parser = state.parser.parsersByExt.get(ext)
          if (!parser) throw new Error(`No parser for: ${ext}`)
          const tree = parser.parse(content)
          try {
            const rootNode = tree?.rootNode ?? null
            if (!rootNode) return { rootNode: null } as ParseTree
            const snapshot = rootNode.toString()
            return {
              rootNode: {
                childCount: rootNode.childCount,
                namedChildCount: rootNode.namedChildCount,
                toString: () => snapshot,
              },
            } as ParseTree
          } finally {
            tree?.delete()
          }
        })
      })

    return { getLanguage, parse, ensureReady: () => ensureWebTreeSitterReady() } satisfies Interface
  }),
)

export {
  parseTypeScriptWithTreeSitter,
  parsePythonWithTreeSitter,
  validateQueryFile,
  QUERY_FILES,
} from "./query-executor.js"
