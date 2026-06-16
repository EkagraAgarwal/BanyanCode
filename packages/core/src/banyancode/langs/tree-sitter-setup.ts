import type { Parser, Language } from "web-tree-sitter"

interface TreeSitterBundle {
  typescript?: Parser
  javascript?: Parser
  python?: Parser
  go?: Parser
  rust?: Parser
}

let bundle: TreeSitterBundle | undefined

export function getTreeSitter(): TreeSitterBundle | undefined {
  return bundle
}

export async function initTreeSitter(): Promise<TreeSitterBundle> {
  if (bundle) return bundle

  const { Parser, Language } = await import("web-tree-sitter")
  await Parser.init()

  const load = async (path: string): Promise<Language | undefined> => {
    try {
      const mod = await import(path, { with: { type: "wasm" } })
      return await Language.load(mod.default)
    } catch {
      return undefined
    }
  }

  const [tsLang, jsLang, pyLang, goLang, rustLang] = await Promise.all([
    load("tree-sitter-typescript/tree-sitter-typescript.wasm").catch(() => undefined),
    load("tree-sitter-javascript/tree-sitter-javascript.wasm").catch(() => undefined),
    load("tree-sitter-python/tree-sitter-python.wasm").catch(() => undefined),
    load("tree-sitter-go/tree-sitter-go.wasm").catch(() => undefined),
    load("tree-sitter-rust/tree-sitter-rust.wasm").catch(() => undefined),
  ])

  const make = (lang: Language | undefined): Parser | undefined => {
    if (!lang) return undefined
    const p = new Parser()
    p.setLanguage(lang)
    return p
  }

  bundle = {
    typescript: make(tsLang),
    javascript: make(jsLang),
    python: make(pyLang),
    go: make(goLang),
    rust: make(rustLang),
  }

  return bundle
}