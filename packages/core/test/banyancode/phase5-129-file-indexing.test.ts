import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CodegraphRepo } from "@opencode-ai/core/banyancode/codegraph-repo"
import { CodegraphIndexer, defaultLayer as codegraphIndexerDefaultLayer } from "../../src/banyancode/codegraph-indexer"
import { tmpdir } from "../fixture/tmpdir"
import * as fs from "node:fs/promises"
import * as path from "node:path"

process.env.BANYANCODE_ENABLE = "1"

const testLayer = Layer.mergeAll(
  codegraphIndexerDefaultLayer,
  CodegraphRepo.defaultLayer,
).pipe(Layer.provide(FSUtil.defaultLayer))

describe("Phase 5: 129-file incremental indexing", () => {
  test("indexFiles completes when more than 128 paths are queued", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const workDir = path.join(tmp.path, "repo")
    await fs.mkdir(workDir, { recursive: true })

    // Create 150 small TS files. The number is intentionally above the
    // bounded queue capacity (128) so the previous producer-then-drain
    // sequence deadlocked.
    const paths: string[] = []
    for (let i = 0; i < 150; i++) {
      const p = path.join(workDir, `f${i}.ts`)
      await fs.writeFile(p, `export const v${i} = ${i}\n`)
      paths.push(p)
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        const result = yield* indexer.indexFiles({ root: workDir, paths })
        expect(result.indexed + result.skipped).toBe(150)
        expect(result.indexed).toBeGreaterThan(0)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  }, 60_000)

  test("removeFiles drops cached trees for removed paths", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const workDir = path.join(tmp.path, "repo")
    await fs.mkdir(workDir, { recursive: true })

    const target = path.join(workDir, "target.ts")
    await fs.writeFile(target, `export const x = 1\n`)

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const indexer = yield* CodegraphIndexer.Service
        // Build the cache.
        yield* indexer.indexFiles({ root: workDir, paths: [target] })
        // Remove the file and confirm no crash, no leftover rows.
        yield* indexer.removeFiles({ root: workDir, paths: [target] })
        const repo = yield* CodegraphRepo.Service
        const after = yield* repo.getFileByPath(target)
        expect(after).toBeUndefined()
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })
})