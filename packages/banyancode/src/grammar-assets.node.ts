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

export const runtimeWasmPath = join(assets, "tree-sitter.wasm")
export const typescriptWasmPath = join(assets, "tree-sitter-typescript.wasm")
