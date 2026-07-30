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

  test("codegraph runtime artifacts (*.db, *.db-wal, *.db-shm) are excluded by DEFAULT_IGNORED", async () => {
    // Stray codegraph DBs (left at workspace root from previous builds or
    // earlier tooling) used to trip the size filter and emit a noisy
    // `Skipping file exceeding size limit` warning every build. The fix
    // adds `*.db` / `*.db-wal` / `*.db-shm` to DEFAULT_IGNORED so they
    // are excluded as gitignore-style artifacts before the size check.
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    // Plant fake artifact files at the workspace root.
    await fs.writeFile(path.join(tmp.path, "codegraph-build.db"), "fake")
    await fs.writeFile(path.join(tmp.path, "codegraph-build.db-wal"), "x".repeat(3_000_000))
    await fs.writeFile(path.join(tmp.path, "codegraph-build.db-shm"), "fake")

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

    // *.db* files are caught by the gitignore-pattern path (DEFAULT_IGNORED),
    // not by the size filter. None of the artifact files should hit the
    // tooLarge bucket or the readError bucket.
    expect(result.skippedByReason.tooLarge).toBe(0)
    expect(result.skippedByReason.readError).toBe(0)
    // And no parse errors from the artifact files.
    expect(result.parseErrors.length).toBe(0)
    expect(result.indexed).toBe(0)
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

  test("auto-generated SDK output (packages/sdk/js/src/v2/gen) is excluded as gitignored, not minified", async () => {
    // Regression for the codegraph warning
    //   "Skipping minified/compiled file: packages/sdk/js/src/v2/gen/sdk.gen.ts"
    // that appeared on every codegraph build. The file is auto-generated by
    // @hey-api/openapi-ts (regenerated by `bun ./packages/sdk/js/script/build.ts`)
    // and contains single-line `export type Foo = { ... }` declarations over
    // 5000 chars long. The minified heuristic at codegraph-indexer.ts:488
    // false-positives on them, and regenerating the SDK churns the graph.
    // Path-based exclusion via DEFAULT_GENERATED_EXCLUDES is the fix.
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const genDir = path.join(tmp.path, "packages", "sdk", "js", "src", "v2", "gen")
    await fs.mkdir(genDir, { recursive: true })

    // Long single line that would trip the minified heuristic at line 488
    // if the gen dir were NOT excluded.
    const longLine = "x".repeat(6000)
    await fs.writeFile(path.join(genDir, "sdk.gen.ts"), `const a = "${longLine}"\n`)

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

    // The gen dir is matched by DEFAULT_GENERATED_EXCLUDES, which is merged
    // into the gitignore patterns array. The walker therefore increments
    // gitignored, NOT minified.
    expect(result.skippedByReason.gitignored).toBeGreaterThanOrEqual(1)
    // The whole point of the fix: this is the bucket that must NOT increment.
    expect(result.skippedByReason.minified).toBe(0)
    expect(result.skippedByReason.tooLarge).toBe(0)
    expect(result.skippedByReason.readError).toBe(0)
    expect(result.skippedByReason.parseFailure).toBe(0)
  })
})