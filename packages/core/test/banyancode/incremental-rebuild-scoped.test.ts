import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"
import { tmpdir } from "../fixture/tmpdir"

process.env.BANYANCODE_ENABLE = "1"

/**
 * Phase 3 RAM spike fix: incremental rebuildDerivedGraph must NOT call
 * searchNodesLight({ limit: 100_000 }). It loads only changed + one-hop
 * neighbor files via nodesByFileIDs.
 */
describe("incremental rebuildDerivedGraph scoping", () => {
  test("applyChanges does not call searchNodesLight", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "graph.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)
    const workDir = path.join(tmp.path, "repo")
    await fs.mkdir(workDir, { recursive: true })

    const paths: string[] = []
    for (let i = 0; i < 40; i++) {
      const p = path.join(workDir, `mod${i}.ts`)
      await fs.writeFile(p, `export function f${i}() { return ${i} }\n`)
      paths.push(p)
    }
    const entry = path.join(workDir, "entry.ts")
    await fs.writeFile(entry, `import { f0 } from "./mod0"\nexport function main() { return f0() }\n`)
    paths.push(entry)

    let searchNodesLightCalls = 0
    const countingRepoLayer = Layer.effect(
      CodegraphRepo.Service,
      Effect.gen(function* () {
        const inner = yield* CodegraphRepo.Service
        return CodegraphRepo.Service.of({
          ...inner,
          searchNodesLight: (input) =>
            Effect.gen(function* () {
              searchNodesLightCalls++
              return yield* inner.searchNodesLight(input)
            }),
        })
      }),
    ).pipe(Layer.provide(codegraphRepoDefaultLayer))

    const indexerLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(countingRepoLayer),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service

        const initial = yield* indexer.indexFiles({ root: workDir, paths, force: true })
        expect(initial.indexed).toBeGreaterThanOrEqual(paths.length)
        searchNodesLightCalls = 0
      }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    await fs.writeFile(entry, `import { f0 } from "./mod0"\nexport function main() { return f0() + 1 }\n`)

    await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const result = yield* indexer.applyChanges({
          root: workDir,
          addedOrChanged: [entry],
          removed: [],
          force: true,
        })
        expect(result.indexed).toBeGreaterThanOrEqual(1)
        expect(searchNodesLightCalls).toBe(0)
      }).pipe(Effect.provide(indexerLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  }, 60_000)
})
