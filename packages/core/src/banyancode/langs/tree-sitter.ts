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

export const HEAP_INITIAL_PAGES = 256
export const HEAP_MAX_PAGES = 4096

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyw"])

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
// disk in dev. We get the path string back (not the bytes), so we feed it to
// `Parser.init({ locateFile })` and `Language.load(path)` — the same pattern
// `packages/opencode/src/tool/shell.ts:317-336` uses for its shell parser.
const importWasmPath = async (specifier: string): Promise<string> => {
  const mod = (await import(specifier as string, { with: { type: "wasm" } })) as { default: string }
  return mod.default
}

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
        const [mainAsset, tsAsset, jsAsset, pyAsset] = await Promise.all([
          importWasmPath("web-tree-sitter/tree-sitter.wasm"),
          importWasmPath("tree-sitter-typescript/tree-sitter-typescript.wasm"),
          importWasmPath("tree-sitter-javascript/tree-sitter-javascript.wasm"),
          importWasmPath("tree-sitter-python/tree-sitter-python.wasm"),
        ])

        const mainPath = resolveAssetPath(mainAsset)
        const tsPath = resolveAssetPath(tsAsset)
        const jsPath = resolveAssetPath(jsAsset)
        const pyPath = resolveAssetPath(pyAsset)

        const webTreeSitter = await import("web-tree-sitter")
        await webTreeSitter.Parser.init({
          locateFile() {
            return mainPath
          },
        })

        const tsLang = await webTreeSitter.Language.load(tsPath)
        const jsLang = await webTreeSitter.Language.load(jsPath)
        const pyLang = await webTreeSitter.Language.load(pyPath)

        const parsersByExt = new Map<string, import("web-tree-sitter").Parser>()
        const languagesByExt = new Map<string, unknown>()
        const tsParser = new webTreeSitter.Parser()
        tsParser.setLanguage(tsLang)
        for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
          parsersByExt.set(ext, tsParser)
          languagesByExt.set(ext, tsLang)
        }

        const jsParser = new webTreeSitter.Parser()
        jsParser.setLanguage(jsLang)
        for (const ext of [".js", ".jsx", ".mjs", ".cjs"]) {
          parsersByExt.set(ext, jsParser)
          languagesByExt.set(ext, jsLang)
        }

        const pyParser = new webTreeSitter.Parser()
        pyParser.setLanguage(pyLang)
        for (const ext of [".py", ".pyw"]) {
          parsersByExt.set(ext, pyParser)
          languagesByExt.set(ext, pyLang)
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
    yield* ensureWebTreeSitterReady()

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
