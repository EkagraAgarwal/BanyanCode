// Bun embeds `with { type: "file" }` imports into a compiled binary and hands
// back a runtime path to the embedded bytes. This is the Bun build path; the
// node build uses grammar-assets.node.ts (selected through package.json
// `imports` conditions). Precedent: packages/core/src/image/photon-wasm.bun.ts.
// @ts-ignore Bun-specific file import attribute.
import runtimeWasm from "../assets/tree-sitter.wasm" with { type: "file" }
// @ts-ignore Bun-specific file import attribute.
import typescriptWasm from "../assets/tree-sitter-typescript.wasm" with { type: "file" }

export const runtimeWasmPath: string = runtimeWasm
export const typescriptWasmPath: string = typescriptWasm
