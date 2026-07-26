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
  test("applyChanges completes with 100 cached and 50 added paths", async () => {
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
        const initial = yield* indexer.indexFiles({ root: workDir, paths: paths.slice(0, 100) })
        expect(initial.indexed).toBe(100)

        const result = yield* indexer.applyChanges({
          root: workDir,
          addedOrChanged: paths,
          removed: [],
        })
        expect(result.indexed).toBe(50)
        expect(result.skipped).toBe(100)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  }, 60_000)

  test("dependentsOfFiles returns connected files and excludes independent files", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const dbLayer = Database.layerFromPath(dbPath)
    const workDir = path.join(tmp.path, "repo")
    await fs.mkdir(workDir, { recursive: true })

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* DatabaseMigration.apply(db)
        const repo = yield* CodegraphRepo.Service

        const files = [
          { id: "changed-file", path: path.join(workDir, "changed.ts") },
          { id: "dependent-file", path: path.join(workDir, "dependent.ts") },
          { id: "reverse-dependent-file", path: path.join(workDir, "reverse.ts") },
          { id: "independent-file", path: path.join(workDir, "independent.ts") },
        ]
        for (const file of files) {
          yield* repo.putFile({
            id: file.id,
            path: file.path,
            contentHash: file.id,
            language: "typescript",
            indexedAt: Date.now(),
          })
        }

        yield* repo.putNodes([
          { id: "changed-node", fileID: "changed-file", kind: "function", name: "changed", startLine: 1, endLine: 1 },
          { id: "dependent-node", fileID: "dependent-file", kind: "function", name: "dependent", startLine: 1, endLine: 1 },
          { id: "reverse-node", fileID: "reverse-dependent-file", kind: "function", name: "reverse", startLine: 1, endLine: 1 },
          { id: "independent-node", fileID: "independent-file", kind: "function", name: "independent", startLine: 1, endLine: 1 },
        ])
        yield* repo.putEdges([
          { id: "dependent-edge", fromNodeID: "dependent-node", toNodeID: "changed-node", kind: "calls" },
          { id: "reverse-edge", fromNodeID: "changed-node", toNodeID: "reverse-node", kind: "references" },
        ])

        const dependents = yield* repo.dependentsOfFiles({ fileIDs: ["changed-file"] })
        expect(dependents).toEqual(["dependent-file", "reverse-dependent-file"])
        expect(dependents).not.toContain("changed-file")
        expect(dependents).not.toContain("independent-file")

        const limited = yield* repo.dependentsOfFiles({ fileIDs: ["changed-file"], limit: 1 })
        expect(limited).toHaveLength(1)
      }).pipe(Effect.provide(testLayer), Effect.provide(dbLayer), Effect.scoped),
    )
  })

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
