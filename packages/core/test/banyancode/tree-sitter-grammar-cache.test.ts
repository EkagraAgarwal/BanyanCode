import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import {
  _resetGrammarLoadCountForTesting,
  _resetTreeSitterStateForTesting,
  ensureWebTreeSitterReady,
  getGrammarLoadCountForTesting,
  treeSitterStateRef,
  withTreeSitter,
} from "../../src/banyancode/langs/tree-sitter"

process.env.BANYANCODE_ENABLE = "1"

const serviceLayer = CodegraphIndexer.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

// Grammar families load once and are never evicted (no LRU reload churn):
// a second full indexing pass over the same files must perform zero
// additional grammar wasm loads.
const indexRoot = (root: string): Promise<unknown> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const indexer = yield* CodegraphIndexer.Service
      return yield* indexer.index({ root, force: true })
    }).pipe(
      Effect.provide(serviceLayer),
      Effect.provide(Database.layerFromPath(path.join(root, "graph.sqlite"))),
      Effect.scoped,
    ),
  )

describe("tree-sitter grammar cache (load-once, never evict)", () => {
  test("second indexing pass over the same files performs zero grammar loads", async () => {
    await using tmp = await tmpdir()
    await fs.writeFile(path.join(tmp.path, "main.ts"), "export function alpha() { return 1 }\n")
    await fs.writeFile(path.join(tmp.path, "app.py"), "def beta():\n    return 2\n")
    await fs.writeFile(path.join(tmp.path, "main.rs"), "fn gamma() -> i32 { 3 }\n")

    await Effect.runPromise(_resetTreeSitterStateForTesting())
    await Effect.runPromise(ensureWebTreeSitterReady())
    _resetGrammarLoadCountForTesting()

    await indexRoot(tmp.path)
    const loadsAfterFirst = getGrammarLoadCountForTesting()
    await indexRoot(tmp.path)
    const loadsAfterSecond = getGrammarLoadCountForTesting()

    expect(loadsAfterSecond - loadsAfterFirst).toBe(0)

    const tsState = await Effect.runPromise(Ref.get(treeSitterStateRef))
    if (tsState._tag === "ready") {
      // The first pass really did load grammars (not a vacuous zero-zero
      // pass through the "unavailable" fallback), and all three families
      // are still resident — nothing was evicted between passes.
      expect(loadsAfterFirst).toBeGreaterThan(0)
      const resident = await Effect.runPromise(
        withTreeSitter((state) =>
          [".ts", ".py", ".rs"].map((ext) => state.parser.languagesByExt.has(ext)),
        ),
      )
      expect(resident).toEqual([true, true, true])
    }
  }, 120_000)
})
