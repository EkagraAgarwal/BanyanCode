import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { tmpdir } from "../fixture/tmpdir"
import path from "path"
import fs from "fs/promises"
import { CodegraphIndexer } from "../../src/banyancode/codegraph-indexer"
import { CodegraphRepo, defaultLayer as codegraphRepoDefaultLayer } from "../../src/banyancode/codegraph-repo"

process.env.BANYANCODE_ENABLE = "1"

describe("CodegraphIndexer", () => {
  test("maxFileSizeBytes skips files exceeding the limit", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Create a 2MB file (should be skipped) and a 100KB file (should be indexed)
    const largeFilePath = path.join(tmp.path, "large.ts")
    const smallFilePath = path.join(tmp.path, "small.ts")
    await fs.writeFile(largeFilePath, "// " + "x".repeat(2 * 1024 * 1024))
    await fs.writeFile(smallFilePath, "// small file\nfunction foo() { return 42 }\n")

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({
          root: tmp.path,
          maxFileSizeBytes: 1_048_576, // 1MB
        })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    // Only the small file should be indexed; the large file should be skipped
    expect(result.indexed).toBe(1)
    expect(result.skipped).toBeGreaterThanOrEqual(1)
  })

  test("default maxFileSizeBytes is 1MB", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Create a 1.5MB file (exceeds default 1MB)
    const tooLargeFilePath = path.join(tmp.path, "toolarge.ts")
    await fs.writeFile(tooLargeFilePath, "// " + "x".repeat(1_500_000))

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        // Don't pass maxFileSizeBytes - should use default 1MB
        return yield* indexer.index({ root: tmp.path })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    // File exceeds default 1MB limit, should be skipped
    expect(result.indexed).toBe(0)
    expect(result.skipped).toBeGreaterThanOrEqual(1)
  })
  test("prunes ignored directories during walkDirectory", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Create a normal directory with a code file
    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(path.join(srcDir, "index.ts"), "function main() {}")

    // Create a directory that should be ignored, and put a code file inside
    const ignoredDir = path.join(tmp.path, "node_modules")
    await fs.mkdir(ignoredDir, { recursive: true })
    await fs.writeFile(path.join(ignoredDir, "dep.ts"), "function parse() {}")

    // Create .gitignore ignoring node_modules
    await fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n")

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

    // index.ts is indexed, dep.ts is pruned and not indexed nor count as skipped
    expect(result.indexed).toBe(1)
    expect(result.skipped).toBe(0)
  })
})
