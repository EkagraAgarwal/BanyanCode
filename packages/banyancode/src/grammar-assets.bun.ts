// Bun embeds `with { type: "file" }` imports into a compiled binary and hands
// back a runtime path to the embedded bytes. This is the Bun build path; the
// node build uses grammar-assets.node.ts (selected through package.json
// `imports` conditions). Precedent: packages/core/src/image/photon-wasm.bun.ts.
//
// Every grammar listed in `GRAMMAR_ASSET_FILES` is imported here explicitly:
// `Bun.build({ compile })` only embeds files it can see at build time, so a
// `readdir`/`join` lookup would work from source and fail in the binary.
// @ts-ignore Bun-specific file import attribute.
import runtimeWasm from "../assets/tree-sitter.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import typescriptWasm from "../assets/tree-sitter-typescript.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import javascriptWasm from "../assets/tree-sitter-javascript.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import pythonWasm from "../assets/tree-sitter-python.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import rustWasm from "../assets/tree-sitter-rust.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import goWasm from "../assets/tree-sitter-go.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import cWasm from "../assets/tree-sitter-c.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import cppWasm from "../assets/tree-sitter-cpp.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import javaWasm from "../assets/tree-sitter-java.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import csharpWasm from "../assets/tree-sitter-c_sharp.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import rubyWasm from "../assets/tree-sitter-ruby.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import phpWasm from "../assets/tree-sitter-php_only.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import bashWasm from "../assets/tree-sitter-bash.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import jsonWasm from "../assets/tree-sitter-json.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import zigWasm from "../assets/tree-sitter-zig.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import tomlWasm from "../assets/tree-sitter-toml.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import yamlWasm from "../assets/tree-sitter-yaml.wasm" with { type: "file" }

export const runtimeWasmPath: string = runtimeWasm
export const typescriptWasmPath: string = typescriptWasm

/** Grammar family → embedded wasm path, matching `GRAMMAR_ASSET_FILES`. */
export const grammarWasmPaths: Readonly<Record<string, string>> = {
  typescript: typescriptWasm,
  javascript: javascriptWasm,
  python: pythonWasm,
  rust: rustWasm,
  go: goWasm,
  c: cWasm,
  cpp: cppWasm,
  java: javaWasm,
  csharp: csharpWasm,
  ruby: rubyWasm,
  php: phpWasm,
  bash: bashWasm,
  json: jsonWasm,
  zig: zigWasm,
  toml: tomlWasm,
  yaml: yamlWasm,
}
