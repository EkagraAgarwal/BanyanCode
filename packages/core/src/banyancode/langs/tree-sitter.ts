export * as TreeSitter from "./tree-sitter"

import { Context, Effect, Layer, Ref } from "effect"
import * as fs from "node:fs/promises"
import path from "node:path"

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

const resolveWasmPath = (...parts: string[]): string => {
  const fromEnv = process.env.TREE_SITTER_WASM_PATH
  if (fromEnv) return fromEnv
  return path.resolve(import.meta.dir, "..", "..", "..", ...parts)
}

export const ensureWebTreeSitterReady = (): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(treeSitterStateRef)
    if (current._tag === "ready") return

    const mainWasmPath = resolveWasmPath("node_modules", "web-tree-sitter", "tree-sitter.wasm")

    const mainBytesOrFailure = yield* Effect.tryPromise({
      try: () => fs.readFile(mainWasmPath),
      catch: describeError,
    }).pipe(
      Effect.match({
        onFailure: (cause) => ({ kind: "err" as const, cause }),
        onSuccess: (buf) => ({ kind: "ok" as const, buf }),
      }),
    )

    if (mainBytesOrFailure.kind === "err") {
      yield* Effect.logWarning(`tree-sitter init: failed to read ${mainWasmPath}: ${mainBytesOrFailure.cause}`)
      yield* Ref.set(treeSitterStateRef, { _tag: "unavailable", cause: mainBytesOrFailure.cause })
      return
    }

    const tsWasmPath = resolveWasmPath("node_modules", "tree-sitter-typescript", "tree-sitter-typescript.wasm")
    const jsWasmPath = resolveWasmPath("node_modules", "tree-sitter-javascript", "tree-sitter-javascript.wasm")
    const pyWasmPath = resolveWasmPath("node_modules", "tree-sitter-python", "tree-sitter-python.wasm")

    const newState = yield* Effect.tryPromise({
      try: async () => {
        const webTreeSitter = await import("web-tree-sitter")
        await webTreeSitter.Parser.init({ wasmBinary: mainBytesOrFailure.buf })

        const [tsBuf, jsBuf, pyBuf] = await Promise.all([
          fs.readFile(tsWasmPath),
          fs.readFile(jsWasmPath),
          fs.readFile(pyWasmPath),
        ])

        const tsLang = await webTreeSitter.Language.load(tsBuf)
        const jsLang = await webTreeSitter.Language.load(jsBuf)
        const pyLang = await webTreeSitter.Language.load(pyBuf)

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
