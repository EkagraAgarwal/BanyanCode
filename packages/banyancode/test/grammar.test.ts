import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { Language, Parser } from "web-tree-sitter"
import { grammarWasmPaths, runtimeWasmPath } from "#grammar-assets"
import { GRAMMAR_ASSET_FILES } from "../src/codegraph/langs/tree-sitter.js"
import { probe } from "../src/grammar.js"

test("tree-sitter runtime and typescript grammar load from plugin assets", async () => {
  const result = await probe()
  expect(result.rootType).toBe("program")
  expect(result.hasError).toBe(false)
  expect(result.wasmPath.length).toBeGreaterThan(0)
})

const SAMPLES: Readonly<Record<string, string>> = {
  typescript: "function hi() { return 1 }",
  javascript: "function hi() { return 1 }",
  python: "def hi():\n  return 1\n",
  rust: "fn hi() -> i32 { 1 }",
  go: "package main\nfunc hi() int { return 1 }\n",
  c: "int hi(void) { return 1; }",
  cpp: "int hi() { return 1; }",
  java: "class A { int hi() { return 1; } }",
  csharp: "class A { int Hi() { return 1; } }",
  ruby: "def hi\n  1\nend\n",
  php: "<?php function hi() { return 1; }",
  bash: "hi() { echo 1; }",
  json: '{"a":1}',
  zig: "fn hi() i32 { return 1; }",
  toml: "a = 1\n",
  yaml: "a: 1\n",
}

test("every grammar in GRAMMAR_ASSET_FILES has an embedded asset path", () => {
  expect(Object.keys(grammarWasmPaths).sort()).toEqual(Object.keys(GRAMMAR_ASSET_FILES).sort())
  for (const grammar of Object.keys(GRAMMAR_ASSET_FILES)) {
    expect(grammarWasmPaths[grammar]?.length ?? 0).toBeGreaterThan(0)
  }
})

test("each grammar wasm loads and parses a tiny sample", async () => {
  await Parser.init({ wasmBinary: await readFile(runtimeWasmPath) })
  for (const grammar of Object.keys(GRAMMAR_ASSET_FILES)) {
    const sample = SAMPLES[grammar]
    expect(sample).toBeDefined()
    const language = await Language.load(await readFile(grammarWasmPaths[grammar]!))
    const parser = new Parser()
    parser.setLanguage(language)
    const tree = parser.parse(sample!)
    expect(tree, `${grammar} returned no tree`).not.toBeNull()
    expect(tree!.rootNode.hasError, `${grammar} parsed with syntax errors`).toBe(false)
    tree!.delete()
    parser.delete()
  }
}, 30_000)
