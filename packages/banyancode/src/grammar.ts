import { readFile } from "node:fs/promises"
import { Language, Parser } from "web-tree-sitter"
import { runtimeWasmPath, typescriptWasmPath } from "#grammar-assets"

export interface GrammarProbe {
  readonly rootType: string
  readonly hasError: boolean
  readonly wasmPath: string
}

let ready: Promise<void> | undefined

/**
 * Loads the tree-sitter runtime plus the TypeScript grammar and parses a tiny
 * program. Workstream 3a will add the remaining 16 grammars; this probe keeps
 * the asset path and wasm initialisation honest in the skeleton.
 */
export async function probe(): Promise<GrammarProbe> {
  ready ??= Parser.init({ wasmBinary: await readFile(runtimeWasmPath) })
  await ready

  const language = await Language.load(await readFile(typescriptWasmPath))
  const parser = new Parser()
  parser.setLanguage(language)
  const tree = parser.parse("function hi() { return 1 }")
  if (!tree) throw new Error("tree-sitter returned no tree")

  const rootType = tree.rootNode.type
  const hasError = tree.rootNode.hasError
  tree.delete()
  parser.delete()

  return { rootType, hasError, wasmPath: typescriptWasmPath }
}
