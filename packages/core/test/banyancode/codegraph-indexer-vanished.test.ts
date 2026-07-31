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

// Regression tests for the watcher / indexer race where a file disappears
// between the watcher event and the indexer's stat() call. Before the fix,
// `fs.stat(...).pipe(Effect.orDie)` killed the whole `applyChanges` fiber on
// PlatformError: NotFound, dropping every other path in the same batch and
// leaving 199 files un-indexed.

const tsContent = (name: string) =>
  `export const ${name} = () => 1\nexport function ${name}Fn(): number { return 1 }\n`

describe("CodegraphIndexer vanished files", () => {
  test("indexFiles survives when a watched file is gone by the time the batch runs", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const aPath = path.join(tmp.path, "a.ts")
    const bPath = path.join(tmp.path, "b.ts")
    const gonePath = path.join(tmp.path, "gone.ts")
    await fs.writeFile(aPath, tsContent("a"))
    await fs.writeFile(bPath, tsContent("b"))
    await fs.writeFile(gonePath, tsContent("gone"))
    await fs.unlink(gonePath)

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.indexFiles({ root: tmp.path, paths: [aPath, gonePath, bPath] })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )

    expect(result.indexed).toBeGreaterThanOrEqual(2)

    const repoLayer = codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
    const paths = listed.map((f) => f.path)
    expect(paths.some((p) => p === aPath)).toBe(true)
    expect(paths.some((p) => p === bPath)).toBe(true)
    expect(paths.some((p) => p === gonePath)).toBe(false)
  })

  test("indexFiles evicts a vanished file's existing graph row", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    const xPath = path.join(tmp.path, "x.ts")
    await fs.writeFile(xPath, tsContent("x"))

    const serviceLayer = CodegraphIndexer.layer.pipe(
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(codegraphRepoDefaultLayer),
    )

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.indexFiles({ root: tmp.path, paths: [xPath] })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    expect(first.indexed).toBe(1)

    await fs.unlink(xPath)

    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* CodegraphIndexer.Service
        return yield* indexer.indexFiles({ root: tmp.path, paths: [xPath] })
      }).pipe(Effect.provide(serviceLayer), Effect.provide(dbLayer), Effect.scoped),
    )
    expect(second.indexed).toBe(0)

    const repoLayer = codegraphRepoDefaultLayer.pipe(Layer.provide(dbLayer))
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CodegraphRepo.Service
        return yield* repo.listAllFiles()
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    )
    expect(listed.find((f) => f.path === xPath)).toBeUndefined()
  })

  test("full index() survives a dangling symlink under the root", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.sqlite")
    const dbLayer = Database.layerFromPath(dbPath)

    await fs.writeFile(path.join(tmp.path, "real.ts"), tsContent("real"))
    const linkPath = path.join(tmp.path, "dangling-link.ts")
    await fs.symlink(path.join(tmp.path, "does-not-exist.ts"), linkPath)

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

    expect(result.indexed).toBeGreaterThanOrEqual(1)
  })
})