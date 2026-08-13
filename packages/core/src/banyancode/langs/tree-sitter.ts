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
import treeSitterCSharpWasm from "tree-sitter-c-sharp/tree-sitter_c_sharp.wasm" with { type: "wasm" }
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
  readonly parsersByExt: ReadonlyMap<string, import("web-tree-sitter").Parser>
  readonly languagesByExt: ReadonlyMap<string, unknown>
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
        // Promise.all over every named source; object insertion order keeps
        // `main` first. `await asset` inside the map normalizes thenables —
        // the same semantics as the original per-entry Promise.resolve
        // wrapper — then each asset path is converted for Language.load.
        const [mainAsset, ...grammarAssets] = await Promise.all(
          (Object.entries(TREE_SITTER_WASM_SOURCES) as Array<[keyof typeof TREE_SITTER_WASM_SOURCES, string]>).map(
            async ([key, asset]) => [key, resolveAssetPath(await asset)] as const,
          ),
        )
        const mainPath = mainAsset[1]
        // `main` is destructured out above, so the remainder is exactly the
        // grammar keys of TREE_SITTER_WASM_SOURCES (typescript … yaml).
        const grammarEntries = grammarAssets as Array<
          readonly [Exclude<keyof typeof TREE_SITTER_WASM_SOURCES, "main">, string]
        >

        const webTreeSitter = await import("web-tree-sitter")
        await webTreeSitter.Parser.init({
          locateFile() {
            return mainPath
          },
        })

        const parsersByExt = new Map<string, import("web-tree-sitter").Parser>()
        const languagesByExt = new Map<string, unknown>()
        for (const [grammar, assetPath] of grammarEntries) {
          const language = await webTreeSitter.Language.load(assetPath)
          // One shared Parser per grammar family so incremental parses
          // (parser.parse(content, oldTree)) stay valid across every
          // extension mapped to the same language.
          const parser = new webTreeSitter.Parser()
          parser.setLanguage(language)
          for (const ext of GRAMMAR_EXTENSIONS[grammar]) {
            parsersByExt.set(ext, parser)
            languagesByExt.set(ext, language)
          }
        }

        return {
          Parser: webTreeSitter.Parser,
          Language: webTreeSitter.Language,
          Query: webTreeSitter.Query,
          parsersByExt,
          languagesByExt,
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

export const parseIncremental = (
  ext: string,
  content: string,
  oldTree: IncrementalTree | undefined,
): Effect.Effect<IncrementalTree, TreeSitterUnavailableError, never> =>
  withTreeSitter((state) => {
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported extension: ${ext}`)
    }
    const language = state.parser.languagesByExt.get(ext) as import("web-tree-sitter").Language | undefined
    if (!language) throw new Error(`No language for: ${ext}`)
    const parser = new state.parser.Parser()
    parser.setLanguage(language)
    return oldTree
      ? (parser.parse(content, oldTree) as IncrementalTree)
      : (parser.parse(content) as IncrementalTree)
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
      withTreeSitter((state) => {
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          throw new Error(`Unsupported extension: ${ext}. Tree-sitter TS/JS/Python scaffold exists; real parsers land in PR 5/6.`)
        }
        const language = state.parser.languagesByExt.get(ext)
        if (language === undefined) throw new Error(`No language for: ${ext}`)
        return language
      })

    const parse = (ext: string, content: string): Effect.Effect<ParseTree, TreeSitterUnavailableError, never> =>
      withTreeSitter((state) => {
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          throw new Error(`Unsupported extension: ${ext}. Tree-sitter TS/JS/Python scaffold exists; real parsers land in PR 5/6.`)
        }
        const parser = state.parser.parsersByExt.get(ext)
        if (!parser) throw new Error(`No parser for: ${ext}`)
        const tree = parser.parse(content)
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
