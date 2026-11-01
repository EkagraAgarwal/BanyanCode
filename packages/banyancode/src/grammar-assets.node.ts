import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Node/SEA build path. Avoid `new URL(..., import.meta.url)` here: Vite's asset
// pipeline rewrites that form and would hand back a URL instead of a path.
// `BANYANCODE_WASM_DIR` (or the existing `OPENCODE_NODE_ASSETS_DIR`) is the
// escape hatch for the Node SEA build, whose asset collector
// (packages/cli/script/node-assets.ts) would stage the wasm files.
const assets =
  process.env.BANYANCODE_WASM_DIR ??
  process.env.OPENCODE_NODE_ASSETS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "assets")

const file = (name: string) => join(assets, name)

export const runtimeWasmPath = file("tree-sitter.wasm")
export const typescriptWasmPath = file("tree-sitter-typescript.wasm")

/** Grammar family → wasm path, matching `GRAMMAR_ASSET_FILES`. */
export const grammarWasmPaths: Readonly<Record<string, string>> = {
  typescript: typescriptWasmPath,
  javascript: file("tree-sitter-javascript.wasm"),
  python: file("tree-sitter-python.wasm"),
  rust: file("tree-sitter-rust.wasm"),
  go: file("tree-sitter-go.wasm"),
  c: file("tree-sitter-c.wasm"),
  cpp: file("tree-sitter-cpp.wasm"),
  java: file("tree-sitter-java.wasm"),
  csharp: file("tree-sitter-c_sharp.wasm"),
  ruby: file("tree-sitter-ruby.wasm"),
  php: file("tree-sitter-php_only.wasm"),
  bash: file("tree-sitter-bash.wasm"),
  json: file("tree-sitter-json.wasm"),
  zig: file("tree-sitter-zig.wasm"),
  toml: file("tree-sitter-toml.wasm"),
  yaml: file("tree-sitter-yaml.wasm"),
}
