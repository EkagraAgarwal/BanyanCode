import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

// Fail-open: with BANYANCODE_CODEGRAPH_BACKEND=rust requested but no
// CodegraphRustParser service in scope (the test runtime never provides it),
// the indexer must still complete via the js pipeline. Also covers
// BANYANCODE_CODEGRAPH_BIN pointing at a nonexistent path: resolution returns
// null and the indexer falls back without dying.
describe("codegraph rust backend — fallback", () => {
  test("rust requested but no parser in scope falls back to js", async () => {
    const prevEnv = process.env.BANYANCODE_CODEGRAPH_BACKEND
    const prevBin = process.env.BANYANCODE_CODEGRAPH_BIN
    process.env.BANYANCODE_CODEGRAPH_BACKEND = "rust"
    process.env.BANYANCODE_CODEGRAPH_BIN = path.join(
      process.env.TEMP ?? "C:\\Windows\\Temp",
      "definitely-not-a-real-binary-" + Math.random().toString(36).slice(2),
    )

    try {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "fallback.sqlite")
      const dbLayer = Database.layerFromPath(dbPath)

      const tsPath = path.join(tmp.path, "alpha.ts")
      await fs.writeFile(
        tsPath,
        "export function hello(name: string): string { return `hi ${name}` }\n",
      )
      const pyPath = path.join(tmp.path, "beta.py")
      await fs.writeFile(
        pyPath,
        "def greet(name):\n    return f'hi {name}'\n",
      )

      const serviceLayer = CodegraphIndexer.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(codegraphRepoDefaultLayer),
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const indexer = yield* CodegraphIndexer.Service
          return yield* indexer.index({ root: tmp.path })
        }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
      )

      expect(result.indexed).toBe(2)
      expect(result.parseErrors.length).toBe(0)
    } finally {
      if (prevEnv === undefined) delete process.env.BANYANCODE_CODEGRAPH_BACKEND
      else process.env.BANYANCODE_CODEGRAPH_BACKEND = prevEnv
      if (prevBin === undefined) delete process.env.BANYANCODE_CODEGRAPH_BIN
      else process.env.BANYANCODE_CODEGRAPH_BIN = prevBin
    }
  })
})