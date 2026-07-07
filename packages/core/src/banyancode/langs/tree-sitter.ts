export * as TreeSitter from "./tree-sitter"

import { Context, Effect, Layer } from "effect"
import { fileURLToPath } from "url"

export const HEAP_INITIAL_PAGES = 256
export const HEAP_MAX_PAGES = 4096

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".pyw"])

export interface ParseTree {
  rootNode: {
    childCount: number
    namedChildCount: number
    toString: () => string
  } | null
}

export interface Interface {
  readonly getLanguage: (ext: string) => Effect.Effect<unknown, never, never>
  readonly parse: (ext: string, content: string) => Effect.Effect<ParseTree, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@banyancode/TreeSitterLoader") {}

let initDone = false

const initEffect = Effect.gen(function* () {
  if (initDone) return
  const { Parser } = yield* Effect.promise(() => import("web-tree-sitter"))
  const { default: treeWasm } = yield* Effect.promise(() =>
    import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } })
  )
  const treePath = resolveWasm(treeWasm as string)
  yield* Effect.promise(() =>
    Parser.init({
      locateFile() {
        return treePath
      },
    })
  )
  initDone = true
})

export const initTreeSitter: () => Effect.Effect<void, never, never> = () => initEffect

const loadGrammars = Effect.gen(function* () {
  const { Parser, Language } = yield* Effect.promise(() => import("web-tree-sitter"))

  const [tsPath, jsPath, pyPath] = yield* Effect.all([
    Effect.promise(async () => {
      const { default: wasm } = await import("tree-sitter-typescript/tree-sitter-typescript.wasm" as string, {
        with: { type: "wasm" },
      })
      return resolveWasm(wasm as string)
    }),
    Effect.promise(async () => {
      const { default: wasm } = await import("tree-sitter-javascript/tree-sitter-javascript.wasm" as string, {
        with: { type: "wasm" },
      })
      return resolveWasm(wasm as string)
    }),
    Effect.promise(async () => {
      const { default: wasm } = await import("tree-sitter-python/tree-sitter-python.wasm" as string, {
        with: { type: "wasm" },
      })
      return resolveWasm(wasm as string)
    }),
  ])

  const [tsLanguage, jsLanguage, pyLanguage] = yield* Effect.all([
    Effect.promise(() => Language.load(tsPath)),
    Effect.promise(() => Language.load(jsPath)),
    Effect.promise(() => Language.load(pyPath)),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type WasmParser = InstanceType<(typeof Parser) & (new () => any)>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type WasmLanguage = InstanceType<(typeof Language) & (new () => any)>

  const tsParser = new Parser() as WasmParser
  tsParser.setLanguage(tsLanguage as WasmLanguage)
  const jsParser = new Parser() as WasmParser
  jsParser.setLanguage(jsLanguage as WasmLanguage)
  const pyParser = new Parser() as WasmParser
  pyParser.setLanguage(pyLanguage as WasmLanguage)

  const map = new Map<string, { parser: WasmParser; language: unknown }>([
    [".ts", { parser: tsParser, language: tsLanguage }],
    [".tsx", { parser: tsParser, language: tsLanguage }],
    [".mts", { parser: tsParser, language: tsLanguage }],
    [".cts", { parser: tsParser, language: tsLanguage }],
    [".js", { parser: jsParser, language: jsLanguage }],
    [".jsx", { parser: jsParser, language: jsLanguage }],
    [".mjs", { parser: jsParser, language: jsLanguage }],
    [".cjs", { parser: jsParser, language: jsLanguage }],
    [".py", { parser: pyParser, language: pyLanguage }],
    [".pyw", { parser: pyParser, language: pyLanguage }],
  ])

  return map
})

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* initTreeSitter()
    const grammarMap = yield* loadGrammars

    const getLanguage = (ext: string) =>
      Effect.gen(function* () {
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          yield* Effect.die(new Error(`Unsupported extension: ${ext}. Tree-sitter TS/JS/Python scaffold exists; real parsers land in PR 5/6.`))
          throw new Error("unreachable")
        }
        const entry = grammarMap.get(ext)
        if (!entry) {
          yield* Effect.die(new Error(`No parser for: ${ext}`))
          throw new Error("unreachable")
        }
        return entry.language
      })

    const parse = (ext: string, content: string) =>
      Effect.gen(function* () {
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          yield* Effect.die(new Error(`Unsupported extension: ${ext}. Tree-sitter TS/JS/Python scaffold exists; real parsers land in PR 5/6.`))
          throw new Error("unreachable")
        }
        const entry = grammarMap.get(ext)
        if (!entry) {
          yield* Effect.die(new Error(`No parser for: ${ext}`))
          throw new Error("unreachable")
        }
        const tree = entry.parser.parse(content)
        return {
          rootNode: tree.rootNode
            ? {
                childCount: tree.rootNode.childCount,
                namedChildCount: tree.rootNode.namedChildCount,
                toString: () => tree.rootNode.toString(),
              }
            : null,
        } as ParseTree
      })

    return {
      getLanguage,
      parse,
    } satisfies Interface
  })
)
