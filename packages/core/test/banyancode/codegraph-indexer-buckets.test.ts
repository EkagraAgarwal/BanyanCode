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

describe("CodegraphIndexer buckets", () => {
  test("correctly categorizes all skip reasons", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })

    await fs.writeFile(path.join(srcDir, "keep.ts"), `export function add(a: number, b: number): number { return a + b }`)

    await fs.mkdir(path.join(tmp.path, "node_modules"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "node_modules", "dep.ts"), `export function dep() {}`)

    await fs.mkdir(path.join(tmp.path, ".banyancode"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, ".banyancode", "ignore"), "src/keep.ts\n")

    await fs.writeFile(path.join(tmp.path, "package.json"), `{"name": "test"}`)

    const bigFilePath = path.join(srcDir, "big.ts")
    await fs.writeFile(bigFilePath, "// " + "x".repeat(1_200_000))

    const minifiedPath = path.join(srcDir, "minified.ts")
    const longLine = "x".repeat(6000)
    await fs.writeFile(minifiedPath, `const a = "${longLine}"\n`)

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({
          root: tmp.path,
          force: true,
          maxFileSizeBytes: 1_048_576,
        })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result.skippedByReason.gitignored).toBeGreaterThanOrEqual(1)
    expect(result.skippedByReason.banyanignored).toBe(1)
    expect(result.skippedByReason.artifact).toBe(0)
    expect(result.skippedByReason.tooLarge).toBeGreaterThanOrEqual(1)
    expect(result.skippedByReason.minified).toBe(1)
    expect(result.skippedByReason.tooLargeParse).toBe(0)
    expect(result.skippedByReason.cached).toBe(0)
    expect(result.skippedByReason.readError).toBe(0)
    expect(result.skippedByReason.parseFailure).toBe(0)
    expect(Array.isArray(result.parseErrors)).toBe(true)
  })

  test("artifact path with no fileKind is skipped", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.writeFile(path.join(tmp.path, "notes.txt"), `plain text file`)

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root: tmp.path, force: true })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result.indexed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(Array.isArray(result.parseErrors)).toBe(true)
  })

  test("skippedByReason sum equals skipped total (no double-count, no residual bucket)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const srcDir = path.join(tmp.path, "src")
    await fs.mkdir(srcDir, { recursive: true })

    await fs.writeFile(path.join(srcDir, "keep.ts"), `export function add(a: number, b: number): number { return a + b }`)

    await fs.mkdir(path.join(tmp.path, "node_modules"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "node_modules", "dep.ts"), `export function dep() {}`)

    await fs.mkdir(path.join(tmp.path, ".banyancode"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, ".banyancode", "ignore"), "src/keep.ts\n")

    await fs.writeFile(path.join(tmp.path, "package.json"), `{"name": "test"}`)

    const bigFilePath = path.join(srcDir, "big.ts")
    await fs.writeFile(bigFilePath, "// " + "x".repeat(1_200_000))

    const minifiedPath = path.join(srcDir, "minified.ts")
    const longLine = "x".repeat(6000)
    await fs.writeFile(minifiedPath, `const a = "${longLine}"\n`)

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const run1 = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root: tmp.path, force: true, maxFileSizeBytes: 1_048_576 })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    const run2 = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root: tmp.path, force: false, maxFileSizeBytes: 1_048_576 })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    const { skippedByReason: sr } = run2
    const sum =
      sr.gitignored +
      sr.banyanignored +
      sr.artifact +
      sr.tooLarge +
      sr.minified +
      sr.tooLargeParse +
      sr.cached +
      sr.readError +
      sr.parseFailure

    expect(sum).toBe(run2.skipped)
    expect(sr.gitignored).toBeGreaterThanOrEqual(1)
    expect(sr.banyanignored).toBe(1)
    expect(sr.artifact).toBe(0)
    expect(sr.tooLarge).toBeGreaterThanOrEqual(1)
    expect(sr.minified).toBe(1)
    expect(sr.tooLargeParse).toBe(0)
    expect(sr.cached).toBeGreaterThanOrEqual(1)
    expect(sr.readError).toBe(0)
    expect(sr.parseFailure).toBe(0)
  })
})