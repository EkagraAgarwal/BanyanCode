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

const serviceLayer = CodegraphIndexer.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(codegraphRepoDefaultLayer),
)

type TestServices = CodegraphIndexer.Service | CodegraphRepo.Service

const run = <A, E>(effect: Effect.Effect<A, E, TestServices>, dbPath: string) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(serviceLayer),
      Effect.provide(codegraphRepoDefaultLayer),
      Effect.provide(Database.layerFromPath(dbPath)),
      Effect.scoped,
    ),
  )

const write = async (root: string, rel: string, content = "function x() { return 1 }\n") => {
  const p = path.join(root, rel)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}

describe("CodegraphIndexer gitignore semantics", () => {
  test("nested .gitignore honored in full build", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, ".gitignore", "node_modules/\n")
    await write(root, "sub/.gitignore", "nested-secret.ts\n")
    await write(root, "sub/nested-secret.ts")
    await write(root, "sub/kept.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(1)
    expect(result.skippedByReason.gitignored).toBeGreaterThan(0)
    const files = await run(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }),
      dbPath,
    )
    const rels = files.map((f) => path.relative(root, f.path).replace(/\\/g, "/"))
    expect(rels).toContain("sub/kept.ts")
    expect(rels).not.toContain("sub/nested-secret.ts")
  })

  test("nested .gitignore honored on incremental (applyChanges) path", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, "sub/.gitignore", "nested-secret.ts\n")

    const secretPath = path.join(root, "sub", "nested-secret.ts")
    await write(root, "sub/nested-secret.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.indexFiles({ root, paths: [secretPath] })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(0)
    expect(result.skipped).toBe(1)
  })

  test("negation re-includes a file (last match wins)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, ".gitignore", "*.ts\n!kept.ts\n")
    await write(root, "dropped.ts")
    await write(root, "kept.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(1)
    const files = await run(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }),
      dbPath,
    )
    const rels = files.map((f) => path.relative(root, f.path).replace(/\\/g, "/"))
    expect(rels).toContain("kept.ts")
    expect(rels).not.toContain("dropped.ts")
  })

  test("root-anchored /pattern does not match deeper directories", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, ".gitignore", "/root-only/\n")
    await write(root, "root-only/secret.ts")
    await write(root, "packages/root-only/kept.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(1)
    const files = await run(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }),
      dbPath,
    )
    const rels = files.map((f) => path.relative(root, f.path).replace(/\\/g, "/"))
    expect(rels).toContain("packages/root-only/kept.ts")
    expect(rels).not.toContain("root-only/secret.ts")
  })

  test("trailing slash is directory-only: dir excluded, sibling file kept", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, ".gitignore", "logs/\n")
    await write(root, "nested/logs/entry.ts")
    await write(root, "other.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(1)
    const files = await run(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }),
      dbPath,
    )
    const rels = files.map((f) => path.relative(root, f.path).replace(/\\/g, "/"))
    expect(rels).toContain("other.ts")
    expect(rels).not.toContain("nested/logs/entry.ts")
  })

  test("** glob excludes deep directories", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, ".gitignore", "**/globbed/\n")
    await write(root, "a/b/globbed/secret.ts")
    await write(root, "a/b/kept.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(1)
  })

  test("slash pattern with wildcard segment matches", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, ".gitignore", "packages/*/.banyancode/\n")
    await write(root, "packages/one/.banyancode/secret.ts")
    await write(root, "packages/one/kept.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(1)
    const files = await run(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }),
      dbPath,
    )
    const rels = files.map((f) => path.relative(root, f.path).replace(/\\/g, "/"))
    expect(rels).toContain("packages/one/kept.ts")
    expect(rels).not.toContain("packages/one/.banyancode/secret.ts")
  })

  test("*.lock excluded in full build", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, "bun.lock", "{\n  \"lockfileVersion\": 1\n}\n")
    await write(root, "src/a.ts")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.index({ root })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(1)
    const files = await run(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }),
      dbPath,
    )
    expect(files.map((f) => path.basename(f.path))).not.toContain("bun.lock")
  })

  test("incremental path does not index non-code files (full/incremental parity)", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    await write(root, "data.json", "{\n  \"a\": 1\n}\n")

    const result = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.indexFiles({ root, paths: [path.join(root, "data.json")] })
      }),
      dbPath,
    )
    expect(result.indexed).toBe(0)
    expect(result.skipped).toBe(1)
  })

  test("coverage floor: tiny change set does not crater coverage", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root)
    const aPath = path.join(root, "a.ts")
    await write(root, "a.ts")
    await write(root, "b.ts")
    await write(root, "c.ts")

    const coverageAfterIncremental = await run(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        const repo = yield* CodegraphRepo.Service
        yield* indexer.index({ root })
        yield* Effect.promise(() => fs.writeFile(aPath, "function changed() { return 2 }\n"))
        yield* indexer.indexFiles({ root, paths: [aPath] })
        return (yield* repo.getMeta())?.graphCoverage ?? 0
      }),
      dbPath,
    )
    expect(coverageAfterIncremental).toBeGreaterThan(0.9)
  })
})
