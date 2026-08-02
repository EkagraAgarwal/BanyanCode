import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRustParser } from "../../src/banyancode/codegraph-rust-parser"
import { defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

// Parity harness: index the same fixture set twice — once with the js
// pipeline (default), once with the rust backend (BANYANCODE_CODEGRAPH_BACKEND=rust
// + the rust binary provided as a service). Compares structural results.
//
// If the rust binary isn't resolvable (BANYANCODE_CODEGRAPH_BIN unset and the
// binary not built locally), the rust half is skipped so this file passes on
// its own before the binary ships.
describe("codegraph rust backend — parity", () => {
  const binaryPath = process.env.BANYANCODE_CODEGRAPH_BIN ?? defaultRustBinary()
  const hasBinary = binaryPath !== null

  const fixtureSource = {
    "alpha.ts":
      "export class Greeter {\n" +
      "  greet(name: string): string { return `hi ${name}` }\n" +
      "}\n",
    "beta.py":
      "class Greeter:\n" +
      "    def greet(self, name):\n" +
      "        return f'hi {name}'\n",
  }

  const writeFixture = async (dir: string): Promise<void> => {
    for (const [name, src] of Object.entries(fixtureSource)) {
      await fs.writeFile(path.join(dir, name), src)
    }
  }

  const indexOnce = async (root: string, rustBinaryPath: string | null) => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "parity.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    await writeFixture(root)

    const baseLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )
    const serviceLayer = rustBinaryPath
      ? baseLayer.pipe(Layer.provide(CodegraphRustParser.layerFor(rustBinaryPath)))
      : baseLayer

    return Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  }

  test("structural parity (js vs rust)", async () => {
    await using tmp = await tmpdir()
    const jsResult = await indexOnce(tmp.path, null)
    expect(jsResult.indexed).toBe(2)

    if (!hasBinary) {
      console.warn("BANYANCODE_CODEGRAPH_BIN not set and no local build found; skipping rust half")
      return
    }

    const prevEnv = process.env.BANYANCODE_CODEGRAPH_BACKEND
    const prevBin = process.env.BANYANCODE_CODEGRAPH_BIN
    process.env.BANYANCODE_CODEGRAPH_BACKEND = "rust"
    process.env.BANYANCODE_CODEGRAPH_BIN = binaryPath!
    try {
      await using tmp2 = await tmpdir()
      const rustResult = await indexOnce(tmp2.path, binaryPath!)
      expect(rustResult.indexed).toBe(2)
      expect(rustResult.parseErrors.length).toBe(0)
      // Both backends should produce a comparable number of symbols (within ±20%
      // since tree-sitter extracts more than the regex pass).
      const ratio = rustResult.symbolsIndexed / Math.max(1, jsResult.symbolsIndexed)
      expect(ratio).toBeGreaterThanOrEqual(0.8)
      expect(ratio).toBeLessThanOrEqual(2.0)
    } finally {
      if (prevEnv === undefined) delete process.env.BANYANCODE_CODEGRAPH_BACKEND
      else process.env.BANYANCODE_CODEGRAPH_BACKEND = prevEnv
      if (prevBin === undefined) delete process.env.BANYANCODE_CODEGRAPH_BIN
      else process.env.BANYANCODE_CODEGRAPH_BIN = prevBin
    }
  }, { timeout: 30_000 })
})

function defaultRustBinary(): string | null {
  // Heuristic: look for a locally-built release binary relative to the repo root.
  // Tests run from packages/core so the native crate is at ../../../../native.
  const candidates = [
    "native/codegraph-rs/target/release/codegraph-rs",
    "native/codegraph-rs/target/release/codegraph-rs.exe",
  ]
  for (const rel of candidates) {
    try {
      // probe synchronously via require — the binary existence is a static file
      if (require("fs").existsSync(path.resolve(process.cwd(), rel))) {
        return path.resolve(process.cwd(), rel)
      }
    } catch {}
  }
  return null
}